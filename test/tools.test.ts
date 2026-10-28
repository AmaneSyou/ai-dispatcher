import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addTask } from '../src/actions.ts';
import type { Adapter, AgentRunInput } from '../src/adapters/types.ts';
import { auditShellCommand } from '../src/audit.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { git, removeWorktree } from '../src/git.ts';
import { mergeTask } from '../src/merge.ts';
import { Runner } from '../src/runner.ts';
import { withTools } from '../src/tools.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

test('工具环境：装了什么就加什么；共享编译缓存只给调度器自己的命令，不给 AI', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-tools-'));
	assert.deepEqual(withTools({ PATH: 'C:\\x' }, 'gate', { root }), { PATH: 'C:\\x' }, '什么都没装：原样返回');
	for (const d of ['bin', 'rust/cargo/bin', 'rust/rustup', 'pnpm-store']) fs.mkdirSync(path.join(root, d), { recursive: true });
	const gate = withTools({ Path: 'C:\\x' }, 'gate', { root, cargoTarget: 'G:\\target' });
	assert.equal(gate.Path, [path.join(root, 'bin'), path.join(root, 'rust', 'cargo', 'bin'), 'C:\\x'].join(path.delimiter), 'Windows 的 Path 键名照用');
	assert.equal(gate.CARGO_HOME, path.join(root, 'rust', 'cargo'));
	assert.equal(gate.RUSTUP_HOME, path.join(root, 'rust', 'rustup'));
	assert.equal(gate.CARGO_TARGET_DIR, 'G:\\target');
	assert.equal(gate.pnpm_config_store_dir, path.join(root, 'pnpm-store'));
	assert.equal(gate.npm_config_store_dir, path.join(root, 'pnpm-store'));
	const worker = withTools({ PATH: 'C:\\x' }, 'worker', { root, cargoTarget: 'G:\\target' });
	assert.equal(worker.CARGO_TARGET_DIR, undefined);
	assert.ok(worker.PATH!.startsWith(path.join(root, 'bin')));
});

test('审计：AI 可以用调度器 tools 里的程序，但调度器目录的其它地方（包括用 .. 绕回去）照样拦', () => {
	const ctx = { worktree: 'G:\\AgentWork\\wt\\p-1', sensitive: ['G:\\调度器'], allowedRead: ['G:\\调度器\\tools'] };
	assert.notEqual(auditShellCommand('G:\\调度器\\tools\\bin\\pnpm.cmd install --offline', ctx).level, 'block');
	assert.equal(auditShellCommand('type G:\\调度器\\dispatcher.config.json', ctx).level, 'block');
	assert.equal(auditShellCommand('type G:\\调度器\\tools\\..\\dispatcher.config.json', ctx).level, 'block');
	assert.equal(auditShellCommand('G:\\调度器\\tools\\bin\\pnpm.cmd && type G:\\调度器\\src\\cli.ts', ctx).level, 'block');
	assert.equal(auditShellCommand('dir G:\\调度器\\toolsX', ctx).level, 'block');
});

async function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-setup-'));
	const repo = path.join(root, 'repo');
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
	// 准备命令生成的东西（像 node_modules 一样）被 .gitignore 忽略，不算 AI 的改动
	fs.writeFileSync(path.join(repo, '.gitignore'), 'deps.txt\n');
	fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
	await git(GIT, repo, ['init', '-b', 'main']);
	await git(GIT, repo, ['add', '-A']);
	await git(GIT, repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
	await git(GIT, repo, ['config', 'user.name', 'tester']);
	await git(GIT, repo, ['config', 'user.email', 'tester@example.com']);
	const cfg: Config = {
		workRoot: path.join(root, 'work'),
		git: GIT,
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 1, maxAttempts: 2, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1e6 } },
		review: { enabled: false, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 1 },
		projects: {
			p: {
				repo,
				baseBranch: 'main',
				// 每跑一次准备命令就在 deps.txt 里追加一行
				setup: [{ name: '装依赖', cmd: 'node -e "require(\'fs\').appendFileSync(\'deps.txt\',\'x\\n\')"' }],
				// 验收要求依赖已经装好
				gates: [{ name: '依赖在', cmd: 'node -e "require(\'fs\').accessSync(\'deps.txt\')"' }],
			},
		},
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { repo, cfg, store };
}

test('准备命令：AI 开始前跑；同一个副本只跑一次；合并时的临时副本里也先跑', async () => {
	const { cfg, store } = await setup();
	const seen: boolean[] = [];
	let round = 0;
	const dsh: Adapter = {
		name: 'dsh',
		async run(i: AgentRunInput) {
			seen.push(fs.existsSync(path.join(i.worktree, 'deps.txt')));
			// 第一轮故意写坏（验收命令能跑但 a.js 写成了相同内容 → 没改动，不通过），第二轮正常改
			if (++round === 2) fs.writeFileSync(path.join(i.worktree, 'src', 'a.js'), 'export const a = 2;\n');
			return { outcome: 'completed', errorCode: null, errorMessage: null, sessionId: 's', finalText: 'ok', usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }, violations: [], exitCode: 0 };
		},
	};
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh }, log: () => {} }).drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.deepEqual(seen, [true, true], 'AI 每一轮开始时依赖都已经装好');
	assert.equal(fs.readFileSync(path.join(t.worktree!, 'deps.txt'), 'utf8'), 'x\n', '两轮只跑了一次准备命令');
	const m = await mergeTask(cfg, store, id);
	assert.equal(m.ok, true, m.message);
});

test('删副本：git 留下的被忽略目录（像 node_modules）也一起删掉', async () => {
	const { repo } = await setup();
	const wt = path.join(path.dirname(repo), 'wt-x');
	await git(GIT, repo, ['worktree', 'add', '--detach', wt, 'main']);
	fs.mkdirSync(path.join(wt, 'node_modules', '.pnpm', 'x'), { recursive: true });
	fs.writeFileSync(path.join(wt, 'node_modules', '.pnpm', 'x', 'index.js'), '1');
	fs.writeFileSync(path.join(wt, 'deps.txt'), 'x');
	await removeWorktree(GIT, repo, wt);
	assert.ok(!fs.existsSync(wt));
	assert.doesNotMatch(await git(GIT, repo, ['worktree', 'list']), /wt-x/);
});

test('准备命令失败：不启动 AI、不扣轮数，交给你并写明原因', async () => {
	const { cfg, store } = await setup();
	cfg.projects.p.setup = [{ name: '装依赖', cmd: 'node -e "process.exit(3)"' }, { name: '第二步', cmd: 'node -e "0"' }];
	let ran = 0;
	const dsh: Adapter = {
		name: 'dsh',
		async run() {
			ran++;
			throw new Error('不该被调用');
		},
	};
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh }, log: () => {} }).drain();
	const t = store.getTask(id)!;
	assert.equal(ran, 0);
	assert.equal(t.status, 'needs_human');
	assert.equal(t.attempts, 0);
	assert.match(t.reason ?? '', /准备命令失败/);
	assert.ok(store.recentEvents(20, id).some((e) => /第二步：已跳过/.test(e.message)));
});
