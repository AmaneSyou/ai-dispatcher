import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addTask } from '../src/actions.ts';
import type { Adapter, AgentRunInput } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { exportPatch, exportPlan, pushToUpstream } from '../src/export.ts';
import { git } from '../src/git.ts';
import { mergeTask } from '../src/merge.ts';
import { approvePlan } from '../src/plan.ts';
import { Runner } from '../src/runner.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

async function makeRepo(dir: string, a: string): Promise<void> {
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
	fs.writeFileSync(path.join(dir, 'src', 'a.js'), a);
	await git(GIT, dir, ['init', '-b', 'main']);
	await git(GIT, dir, ['config', 'user.name', 'tester']);
	await git(GIT, dir, ['config', 'user.email', 'tester@example.com']);
	await git(GIT, dir, ['add', '-A']);
	await git(GIT, dir, ['commit', '-m', 'init']);
}

// 调度器里的项目副本，加一个和它“没有共同历史、内容相同”的你自己的仓库（模拟从备份重建的情况）
async function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-export-'));
	const repo = path.join(root, 'repo');
	const mine = path.join(root, 'mine');
	await makeRepo(repo, 'export const a = 1;\nexport const keep = 0;\n');
	await makeRepo(mine, 'export const a = 1;\nexport const keep = 0;\n');
	const cfg: Config = {
		workRoot: path.join(root, 'work'),
		git: GIT,
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1e6 } },
		review: { enabled: false, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 1 },
		projects: { p: { repo, baseBranch: 'main', gates: [], upstream: { repo: mine, branch: 'main' } } },
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { repo, mine, cfg, store };
}

const ok = (finalText = 'ok') => ({ outcome: 'completed' as const, errorCode: null, errorMessage: null, sessionId: 's', finalText, usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }, violations: [], exitCode: 0 });

async function doneTask(cfg: Config, store: Store, edit: (wt: string) => void, title = '改 a'): Promise<number> {
	const dsh: Adapter = { name: 'dsh', async run(i: AgentRunInput) { edit(i.worktree); return ok(); } };
	const id = addTask(cfg, store, { project: 'p', title, spec: '把 a 改成 2', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh }, log: () => {} }).drain();
	assert.equal(store.getTask(id)!.status, 'passed');
	return id;
}

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

test('导出补丁：待验收和已合并的任务都能导出；补丁能在没有共同历史的你的仓库里用 git am 应用，并带上说明', async () => {
	const { cfg, store, mine } = await setup();
	const id = await doneTask(cfg, store, (wt) => fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'export const a = 2;\nexport const keep = 0;\n'));
	const before = await exportPatch(cfg, store, id);
	assert.ok(fs.existsSync(before.file));
	assert.equal((await mergeTask(cfg, store, id)).ok, true);
	const { file } = await exportPatch(cfg, store, id);
	assert.match(fs.readFileSync(file, 'utf8'), /Subject: \[PATCH\]/);
	await git(GIT, mine, ['am', file]);
	assert.equal(read(mine, 'src/a.js'), 'export const a = 2;\nexport const keep = 0;\n');
	assert.match(await git(GIT, mine, ['log', '-1', '--format=%B']), /由 AI 调度器任务 #\d+ 生成/);
	assert.equal(JSON.parse(store.getTask(id)!.export_info!).patch, file);
});

test('推送：在你仓库的最新代码上应用后推到新分支；不碰你的 main 和工作目录；同名分支已存在时另起名字', async () => {
	const { cfg, store, mine } = await setup();
	// 你自己的仓库在别处又有了新提交（不冲突）
	fs.writeFileSync(path.join(mine, 'README.md'), '# mine\n');
	await git(GIT, mine, ['add', '-A']);
	await git(GIT, mine, ['commit', '-m', 'mine: readme']);
	const mainBefore = (await git(GIT, mine, ['rev-parse', 'main'])).trim();
	const id = await doneTask(cfg, store, (wt) => fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'export const a = 2;\nexport const keep = 0;\n'));
	const r = await pushToUpstream(cfg, store, id);
	assert.equal(r.ok, true, r.message);
	assert.equal(r.branch, `dispatcher/task-${id}`);
	assert.equal((await git(GIT, mine, ['rev-parse', 'main'])).trim(), mainBefore, '你的 main 没动');
	assert.equal(read(mine, 'src/a.js'), 'export const a = 1;\nexport const keep = 0;\n', '你的工作目录没动');
	assert.match(await git(GIT, mine, ['show', `${r.branch}:src/a.js`]), /a = 2/);
	assert.match(await git(GIT, mine, ['show', `${r.branch}:README.md`]), /mine/, '基于你仓库的最新代码');
	const again = await pushToUpstream(cfg, store, id);
	assert.equal(again.ok, true, again.message);
	assert.notEqual(again.branch, r.branch);
	assert.ok(again.branch!.startsWith(`dispatcher/task-${id}-`));
});

test('推送：和你仓库的最新代码冲突就不推，也不留下分支', async () => {
	const { cfg, store, mine } = await setup();
	fs.writeFileSync(path.join(mine, 'src', 'a.js'), 'export const a = 99;\nexport const keep = 0;\n');
	await git(GIT, mine, ['commit', '-am', 'mine: a = 99']);
	const id = await doneTask(cfg, store, (wt) => fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'export const a = 2;\nexport const keep = 0;\n'));
	const r = await pushToUpstream(cfg, store, id);
	assert.equal(r.ok, false);
	assert.deepEqual(r.conflicts, ['src/a.js']);
	assert.equal((await git(GIT, mine, ['branch', '--list', 'dispatcher/*'])).trim(), '');
});

test('大任务批量导出：按合并顺序每个子任务一个补丁，依次应用就是全部改动；没改动或状态不对的不能导出', async () => {
	const { cfg, store, mine } = await setup();
	const plan = { items: [{ title: '建 b', spec: '新建 src/b.js', allow: ['src/b.js'] }, { title: '建 c', spec: '新建 src/c.js', allow: ['src/c.js'], depends_on: [1] }] };
	const dsh: Adapter = {
		name: 'dsh',
		async run(i: AgentRunInput) {
			if (i.prompt.includes('规划代理')) return ok('```json\n' + JSON.stringify(plan) + '\n```');
			const n = /建 (\w)/.exec(i.prompt)![1];
			fs.writeFileSync(path.join(i.worktree, 'src', `${n}.js`), `export const ${n} = 1;\n`);
			return ok();
		},
	};
	const runner = new Runner({ cfg, store, adapters: { dsh }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: 's', agent: 'dsh', split: { autoMerge: true } });
	await runner.drain();
	approvePlan(cfg, store, id);
	await runner.drain();
	const { dir } = await exportPlan(cfg, store, id);
	const files = fs.readdirSync(dir).sort();
	assert.equal(files.length, 2);
	for (const f of files) await git(GIT, mine, ['am', path.join(dir, f)]);
	assert.ok(fs.existsSync(path.join(mine, 'src', 'b.js')) && fs.existsSync(path.join(mine, 'src', 'c.js')));

	const queued = addTask(cfg, store, { project: 'p', title: 'x', spec: 's', agent: 'dsh' });
	await assert.rejects(exportPatch(cfg, store, queued), /只有“待验收”“已接受”“已合并”的任务可以导出/);
});
