import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Adapter, AgentRunInput } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { git } from '../src/git.ts';
import { mergeTask, undoMerge } from '../src/merge.ts';
import { Runner } from '../src/runner.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

async function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-merge-'));
	const repo = path.join(root, 'repo');
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
	fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
	fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'export const b = 1;\n');
	await git(GIT, repo, ['init', '-b', 'main']);
	await git(GIT, repo, ['add', '-A']);
	await git(GIT, repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
	// 合并提交用仓库自己的身份（测试机上可能没有全局身份）
	await git(GIT, repo, ['config', 'user.name', 'tester']);
	await git(GIT, repo, ['config', 'user.email', 'tester@example.com']);
	const cfg: Config = {
		workRoot: path.join(root, 'work'),
		git: GIT,
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 2, maxAttempts: 1, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1e6 } },
		projects: { p: { repo, baseBranch: 'main', gates: [{ name: '能加载', cmd: 'node -e "import(\'./src/a.js\')"', timeoutMinutes: 1 }] } },
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { repo, cfg, store };
}

// 让假 worker 把某个文件写成给定内容，跑到“待验收”
async function passTask(cfg: Config, store: Store, file: string, content: string): Promise<number> {
	const id = store.createTask({ project: 'p', title: `改 ${file}`, spec: 's', allow: ['src/**'], readonly: [], agent: 'dsh', maxAttempts: 1 });
	const adapter: Adapter = {
		name: 'dsh',
		async run(i: AgentRunInput) {
			fs.writeFileSync(path.join(i.worktree, 'src', file), content);
			return { outcome: 'completed', errorCode: null, errorMessage: null, sessionId: 's', finalText: '', usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }, violations: [], exitCode: 0 };
		},
	};
	await new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} }).drain();
	assert.equal(store.getTask(id)?.status, 'passed');
	return id;
}

// Git 的 autocrlf 会在检出时把换行换成 \r\n，比较内容时统一一下
const read = (repo: string, f: string) => fs.readFileSync(path.join(repo, 'src', f), 'utf8').replace(/\r\n/g, '\n');

test('合并：在副本里合并并复检通过后更新项目；撤销用反向提交恢复原样', async () => {
	const { repo, cfg, store } = await setup();
	const id = await passTask(cfg, store, 'a.js', 'export const a = 2;\n');
	const r = await mergeTask(cfg, store, id);
	assert.equal(r.ok, true, r.message);
	assert.equal(store.getTask(id)?.status, 'merged');
	assert.equal(read(repo, 'a.js'), 'export const a = 2;\n', '你检出的 main 被快进到合并结果');
	assert.match(await git(GIT, repo, ['log', '-1', '--format=%s']), /合并任务 #\d+/);

	const u = await undoMerge(cfg, store, id);
	assert.equal(u.ok, true, u.message);
	assert.equal(read(repo, 'a.js'), 'export const a = 1;\n');
	assert.equal(store.getTask(id)?.status, 'accepted');
	assert.match(await git(GIT, repo, ['log', '-1', '--format=%s']), /Revert/);
});

test('你的项目有未提交改动：拒绝更新，不碰你的改动', async () => {
	const { repo, cfg, store } = await setup();
	const id = await passTask(cfg, store, 'a.js', 'export const a = 2;\n');
	fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'export const b = 99; // 你正在改\n');
	const before = (await git(GIT, repo, ['rev-parse', 'main'])).trim();
	const r = await mergeTask(cfg, store, id);
	assert.equal(r.ok, false);
	assert.match(r.message, /未提交的改动/);
	assert.equal((await git(GIT, repo, ['rev-parse', 'main'])).trim(), before);
	assert.equal(read(repo, 'b.js'), 'export const b = 99; // 你正在改\n');
	assert.equal(store.getTask(id)?.status, 'passed');
});

test('两个任务改了同一处：第二个合并时报冲突，项目不变', async () => {
	const { repo, cfg, store } = await setup();
	const first = await passTask(cfg, store, 'a.js', 'export const a = 2;\n');
	const second = await passTask(cfg, store, 'a.js', 'export const a = 3;\n');
	assert.equal((await mergeTask(cfg, store, first)).ok, true);
	const before = (await git(GIT, repo, ['rev-parse', 'main'])).trim();
	const r = await mergeTask(cfg, store, second);
	assert.equal(r.ok, false);
	assert.deepEqual(r.conflicts, ['src/a.js']);
	assert.equal((await git(GIT, repo, ['rev-parse', 'main'])).trim(), before);
	assert.match(store.getTask(second)?.reason ?? '', /冲突/);
	assert.equal(read(repo, 'a.js'), 'export const a = 2;\n');
});

test('合并后的整体检查没过：项目不变', async () => {
	const { repo, cfg, store } = await setup();
	const id = await passTask(cfg, store, 'a.js', 'export const a = 2;\n');
	cfg.projects.p.gates = [{ name: '必然失败', cmd: 'node -e "process.exit(1)"', timeoutMinutes: 1 }];
	const before = (await git(GIT, repo, ['rev-parse', 'main'])).trim();
	const r = await mergeTask(cfg, store, id);
	assert.equal(r.ok, false);
	assert.match(r.message, /整体检查没通过/);
	assert.equal((await git(GIT, repo, ['rev-parse', 'main'])).trim(), before);
});

test('你检出的是别的分支：直接移动 main，不动你当前的工作目录', async () => {
	const { repo, cfg, store } = await setup();
	const id = await passTask(cfg, store, 'a.js', 'export const a = 2;\n');
	await git(GIT, repo, ['checkout', '-q', '-b', 'my-work']);
	const r = await mergeTask(cfg, store, id);
	assert.equal(r.ok, true, r.message);
	assert.equal(read(repo, 'a.js'), 'export const a = 1;\n', '当前检出的 my-work 不受影响');
	assert.match(await git(GIT, repo, ['show', 'main:src/a.js']), /a = 2/);
});
