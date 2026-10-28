import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addTask, cancelTask } from '../src/actions.ts';
import type { Adapter, AgentRunInput } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { git } from '../src/git.ts';
import { mergeTask } from '../src/merge.ts';
import { approvePlan, extractPlan, normalizePlan } from '../src/plan.ts';
import { Runner } from '../src/runner.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

test('取方案：取最后一个 json 代码块；没有代码块就取大括号；都没有报错', () => {
	const text = '先看了代码。\n```json\n{"items":[]}\n```\n修正版：\n```json\n{"summary":"s","items":[{"title":"a","spec":"b"}]}\n```';
	assert.deepEqual(extractPlan(text), { summary: 's', items: [{ title: 'a', spec: 'b' }] });
	assert.deepEqual(extractPlan('方案 {"items":[{"title":"a","spec":"b"}]} 完'), { items: [{ title: 'a', spec: 'b' }] });
	assert.throws(() => extractPlan('没有方案'), /没有找到/);
	assert.throws(() => extractPlan('```json\n{坏的}\n```'), /不是合法的 json/);
});

test('检查方案：依赖只能指向前面的项；代理要可用；标题和说明必填；数量有上限', () => {
	const ok = normalizePlan({ summary: ' 思路 ', items: [{ title: 'a', spec: 'x' }, { title: 'b', spec: 'y', allow: ['src/b.js', ''], agent: 'dsh', depends_on: [1, 1] }] }, ['dsh']);
	assert.equal(ok.summary, '思路');
	assert.deepEqual(ok.items[1], { title: 'b', spec: 'y', allow: ['src/b.js'], agent: 'dsh', depends_on: [1] });
	assert.equal(ok.items[0].agent, null);
	const bad = (items: unknown[], re: RegExp) => assert.throws(() => normalizePlan({ items }, ['dsh']), re);
	bad([{ title: 'a', spec: 'x', depends_on: [1] }], /第 1 项的依赖/);
	bad([{ title: 'a', spec: 'x' }, { title: 'b', spec: 'y', depends_on: [3] }], /第 2 项的依赖/);
	bad([{ title: 'a', spec: 'x', agent: 'codex' }], /不可用/);
	bad([{ title: '', spec: 'x' }], /没有标题/);
	bad([{ title: 'a', spec: ' ' }], /没有说明/);
	bad([], /一项小任务都没有/);
	bad(Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, spec: 's' })), /最多 12 项/);
});

async function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-plan-'));
	const repo = path.join(root, 'repo');
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
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
		agents: { dsh: { install: '', concurrency: 2, maxAttempts: 1, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1e6 } },
		projects: { p: { repo, baseBranch: 'main', gates: [{ name: '能加载', cmd: 'node -e "import(\'./src/a.js\')"', timeoutMinutes: 1 }] } },
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { repo, cfg, store };
}

const PLAN = {
	summary: '先建 b 再建 c',
	items: [
		{ title: '建 b', spec: '新建 src/b.js', allow: ['src/b.js'], agent: null, depends_on: [] },
		{ title: '建 c', spec: '新建 src/c.js，引用 b', allow: ['src/c.js'], agent: null, depends_on: [1] },
	],
};

// 假 worker：收到拆分说明就交方案；收到普通任务就按标题建文件。记录每个任务开始时项目里已有哪些文件
function fakeWorker(planText: string, seen: Record<string, string[]> = {}): Adapter {
	return {
		name: 'dsh',
		async run(i: AgentRunInput) {
			let finalText = '完成';
			if (i.prompt.includes('规划代理')) finalText = planText;
			else {
				const name = /建 (\w)/.exec(i.prompt)![1];
				seen[name] = fs.readdirSync(path.join(i.worktree, 'src')).sort();
				fs.writeFileSync(path.join(i.worktree, 'src', `${name}.js`), `export const ${name} = 1;\n`);
			}
			return { outcome: 'completed', errorCode: null, errorMessage: null, sessionId: 's', finalText, usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }, violations: [], exitCode: 0 };
		},
	};
}

test('拆分全流程：出方案 → 批准生成子任务 → 有依赖的等前一项自动合并后才开始 → 全部合并后大任务完成', async () => {
	const { repo, cfg, store } = await setup();
	const seen: Record<string, string[]> = {};
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeWorker('方案如下\n```json\n' + JSON.stringify(PLAN) + '\n```', seen) }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: '建 b 和 c', allow: ['src/**'], readonly: ['test/**'], agent: 'dsh', split: { childAgent: 'dsh', autoMerge: true } });
	await runner.drain();
	const planned = store.getTask(id)!;
	assert.equal(planned.status, 'planned');
	assert.equal(planned.worktree, null, '拆分用的副本已清理');
	assert.equal(JSON.parse(planned.plan_json!).items.length, 2);

	approvePlan(cfg, store, id);
	const [b, c] = store.childrenOf(id);
	assert.equal(store.getTask(id)!.status, 'split');
	assert.deepEqual(c.depends_on, [b.id]);
	assert.equal(b.auto_merge, 1);
	assert.deepEqual(b.readonly, ['test/**'], '子任务沿用大任务的禁止修改');
	assert.match(c.spec, /拆出的第 2\/2 项/);

	await runner.drain();
	assert.equal(store.getTask(b.id)!.status, 'merged');
	assert.equal(store.getTask(c.id)!.status, 'merged');
	assert.deepEqual(seen.c, ['a.js', 'b.js'], 'c 开始时已经拿到了 b 合并后的代码');
	assert.equal(store.getTask(id)!.status, 'merged');
	assert.ok(fs.existsSync(path.join(repo, 'src', 'c.js')));
});

test('不自动合并：后一项一直等，直到你把前一项合并进项目', async () => {
	const { cfg, store } = await setup();
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeWorker('```json\n' + JSON.stringify(PLAN) + '\n```') }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: 's', agent: 'dsh', split: { childAgent: 'dsh' } });
	await runner.drain();
	approvePlan(cfg, store, id);
	const [b, c] = store.childrenOf(id);
	await runner.drain();
	assert.equal(store.getTask(b.id)!.status, 'passed');
	assert.equal(store.getTask(c.id)!.status, 'queued');
	assert.equal((await mergeTask(cfg, store, b.id)).ok, true);
	assert.equal(store.getTask(id)!.status, 'split', '还有一项没合并');
	await runner.drain();
	assert.equal(store.getTask(c.id)!.status, 'passed');
});

test('人改过的方案：按改过的生成；方案有错就一个子任务都不建', async () => {
	const { cfg, store } = await setup();
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeWorker('```json\n' + JSON.stringify(PLAN) + '\n```') }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: 's', agent: 'dsh', split: {} });
	await runner.drain();
	assert.throws(() => approvePlan(cfg, store, id, { items: [{ title: 'x', spec: 'y' }, { title: 'z', spec: 'w', depends_on: [2] }] }), /第 2 项的依赖/);
	assert.equal(store.childrenOf(id).length, 0);
	assert.equal(store.getTask(id)!.status, 'planned');
	approvePlan(cfg, store, id, { summary: '', items: [{ title: '只建 b', spec: 'y' }] });
	assert.deepEqual(store.childrenOf(id).map((k) => k.title), ['只建 b']);
});

test('AI 没给出能用的方案：按验收没通过处理，轮数用完交给你，并写明原因', async () => {
	const { cfg, store } = await setup();
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeWorker('我觉得不用拆') }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: 's', agent: 'dsh', split: {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.match(t.last_report ?? '', /没有得到可用的拆分方案/);
});

test('取消大任务：没结束的子任务一起取消，已合并的保留', async () => {
	const { cfg, store } = await setup();
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeWorker('```json\n' + JSON.stringify(PLAN) + '\n```') }, log: () => {} });
	const id = addTask(cfg, store, { project: 'p', title: '大任务', spec: 's', agent: 'dsh', split: {} });
	await runner.drain();
	approvePlan(cfg, store, id);
	const [b, c] = store.childrenOf(id);
	// 第一项跑完并合并；第二项还在排队时取消大任务
	await runner.drain();
	assert.equal((await mergeTask(cfg, store, b.id)).ok, true);
	assert.equal(store.getTask(id)!.status, 'split');
	await cancelTask(cfg, store, id);
	assert.equal(store.getTask(b.id)!.status, 'merged');
	assert.equal(store.getTask(c.id)!.status, 'cancelled');
	assert.equal(store.getTask(id)!.status, 'cancelled');
});
