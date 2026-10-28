import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addTask } from '../src/actions.ts';
import type { Adapter, AgentRunInput, AgentRunResult } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { git } from '../src/git.ts';
import { Runner } from '../src/runner.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

async function setup(extra: Partial<Config> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-assist-'));
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
		agents: { dsh: { install: '', concurrency: 2, maxAttempts: 2, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1e6 } },
		projects: { p: { repo, baseBranch: 'main', gates: [{ name: '能加载', cmd: 'node -e "import(\'./src/a.js\')"', timeoutMinutes: 1 }] } },
		...extra,
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { repo, cfg, store };
}

const ok = (finalText: string): AgentRunResult => ({ outcome: 'completed', errorCode: null, errorMessage: null, sessionId: 's', finalText, usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }, violations: [], exitCode: 0 });
const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';

// 假 AI：按收到的说明决定做什么，并记下每次的说明
function fake(name: string, h: { judge?: () => AgentRunResult; review?: (i: AgentRunInput) => AgentRunResult; work?: (i: AgentRunInput) => void }, log: string[] = []): Adapter {
	return {
		name,
		async run(i: AgentRunInput) {
			if (i.prompt.includes('判断任务难度')) {
				log.push(`${name}:judge`);
				return h.judge ? h.judge() : ok(json({ agent: 'dsh', difficulty: '简单', reason: '改一个常量' }));
			}
			if (i.prompt.includes('代码复核员')) {
				log.push(`${name}:review`);
				return h.review ? h.review(i) : ok(json({ verdict: 'approve', summary: '没问题', issues: [] }));
			}
			log.push(`${name}:work`);
			if (h.work) h.work(i);
			else fs.writeFileSync(path.join(i.worktree, 'src', 'a.js'), `export const a = ${log.length + 1};\n`);
			return ok(`${name} 完成`);
		},
	};
}

test('自动分配：Codex 判断后交给 DSH 做；判断结果记下来；判断用的临时副本清理掉', async () => {
	const { cfg, store } = await setup({ review: { enabled: false, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 1 } });
	const log: string[] = [];
	const adapters = { dsh: fake('dsh', {}, log), codex: fake('codex', {}, log) };
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: '把 a 改掉', agent: 'auto' });
	await new Runner({ cfg, store, adapters, log: () => {} }).drain();
	const t = store.getTask(id)!;
	assert.deepEqual(log, ['codex:judge', 'dsh:work']);
	assert.equal(t.agent, 'dsh');
	assert.equal(t.status, 'passed');
	assert.equal(JSON.parse(t.triage!).by, 'codex');
	assert.equal(store.attemptsFor(id).length, 2, '判断那一轮也记了用量');
	assert.deepEqual(fs.readdirSync(path.join(cfg.workRoot, 'wt')).filter((d) => d.startsWith('_triage-')), []);
});

test('判断者没额度就换：Codex → Claude → DSH；关掉 DSH 兜底时就等着', async () => {
	const off = { review: { enabled: false, agent: 'claude' as const, fallback: true, scope: 'dsh' as const, maxFixRounds: 1 } };
	for (const [blocked, expect] of [
		[['codex'], 'claude:judge'],
		[['codex', 'claude'], 'dsh:judge'],
	] as const) {
		const { cfg, store } = await setup(off);
		const log: string[] = [];
		const adapters = { dsh: fake('dsh', {}, log), codex: fake('codex', {}, log), claude: fake('claude', {}, log) };
		addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'auto' });
		await new Runner({ cfg, store, adapters, log: () => {}, quotaBlock: (a) => ((blocked as readonly string[]).includes(a) ? '额度保护' : null) }).drain();
		assert.equal(log[0], expect);
	}
	const { cfg, store } = await setup({ ...off, triage: { agent: 'codex', dshFallback: false } });
	const log: string[] = [];
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'auto' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}, log), codex: fake('codex', {}, log) }, log: () => {}, quotaBlock: (a) => (a === 'codex' ? '额度保护' : null) }).drain();
	assert.deepEqual(log, []);
	assert.equal(store.getTask(id)!.status, 'queued');
});

test('判断结果读不出来：按默认交给升级顺序里的第一家，并写明原因', async () => {
	const { cfg, store } = await setup({ review: { enabled: false, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 1 } });
	const log: string[] = [];
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'auto' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}, log), codex: fake('codex', { judge: () => ok('我觉得挺简单的') }, log) }, log: () => {} }).drain();
	assert.equal(store.getTask(id)!.agent, 'dsh');
	assert.ok(store.recentEvents(50, id).some((e) => /难度判断没成功/.test(e.message)));
});

test('复核通过：DSH 做完、Claude 复核，再交给你；复核意见记下来', async () => {
	const { cfg, store } = await setup();
	const log: string[] = [];
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}, log), claude: fake('claude', {}, log) }, log: () => {} }).drain();
	assert.deepEqual(log, ['dsh:work', 'claude:review']);
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.equal(JSON.parse(t.review!).verdict, 'approve');
});

test('复核发现问题：交回 DSH 在原会话里改（说明里写明是复核员的意见），改完再复核通过', async () => {
	const { cfg, store } = await setup();
	const log: string[] = [];
	const prompts: string[] = [];
	let reviews = 0;
	const claude = fake('claude', {
		review: () => (++reviews === 1 ? ok(json({ verdict: 'changes', summary: '漏了一种情况', issues: ['src/a.js：没处理负数'] })) : ok(json({ verdict: 'approve', summary: '好了', issues: [] }))),
	}, log);
	const dsh = fake('dsh', { work: (i) => { prompts.push(i.prompt); fs.writeFileSync(path.join(i.worktree, 'src', 'a.js'), `export const a = ${prompts.length + 1};\n`); } }, log);
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh, claude }, log: () => {} }).drain();
	assert.deepEqual(log, ['dsh:work', 'claude:review', 'dsh:work', 'claude:review']);
	assert.match(prompts[1], /复核员（claude）/);
	assert.match(prompts[1], /没处理负数/);
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.equal(t.review_rounds, 1);
	assert.equal(t.feedback, null);
});

test('返工次数用完还有问题：交给你并写明，不自动合并', async () => {
	const { cfg, store } = await setup({ review: { enabled: true, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 0 } });
	const claude = fake('claude', { review: () => ok(json({ verdict: 'changes', summary: '', issues: ['有问题'] })) });
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	store.updateTask(id, { auto_merge: 1 });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}), claude }, log: () => {} }).drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed', '没有被自动合并');
	assert.match(t.reason ?? '', /复核认为还有 1 个问题/);
});

test('复核的 AI 都没额度：不等，直接交给你并写明“没有复核”', async () => {
	const { cfg, store } = await setup();
	const log: string[] = [];
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}, log), claude: fake('claude', {}, log), codex: fake('codex', {}, log) }, log: () => {}, quotaBlock: (a) => (a === 'dsh' ? null : '额度保护') }).drain();
	assert.deepEqual(log, ['dsh:work']);
	assert.match(store.getTask(id)!.reason ?? '', /没有复核/);
	assert.equal(store.getTask(id)!.status, 'passed');
});

test('复核时 AI 改了文件：丢掉这些改动，保持验收通过时的样子', async () => {
	const { cfg, store } = await setup();
	const claude = fake('claude', {
		review: (i) => {
			fs.writeFileSync(path.join(i.worktree, 'src', 'a.js'), 'export const a = "被复核改了";\n');
			fs.writeFileSync(path.join(i.worktree, 'src', 'new.js'), 'x');
			return ok(json({ verdict: 'approve', summary: '', issues: [] }));
		},
	});
	const id = addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}), claude }, log: () => {} }).drain();
	const t = store.getTask(id)!;
	assert.doesNotMatch(fs.readFileSync(path.join(t.worktree!, 'src', 'a.js'), 'utf8'), /被复核改了/);
	assert.ok(!fs.existsSync(path.join(t.worktree!, 'src', 'new.js')));
	assert.ok(store.recentEvents(50, id).some((e) => /已丢弃这些改动/.test(e.message)));
});

test('只复核 DSH 做的：Claude 做的不复核；关掉复核时都不复核', async () => {
	const { cfg, store } = await setup();
	cfg.agents.claude = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 };
	const log: string[] = [];
	addTask(cfg, store, { project: 'p', title: '改 a', spec: 's', agent: 'claude' });
	await new Runner({ cfg, store, adapters: { dsh: fake('dsh', {}, log), claude: fake('claude', {}, log), codex: fake('codex', {}, log) }, log: () => {} }).drain();
	assert.deepEqual(log, ['claude:work']);

	const s2 = await setup({ review: { enabled: false, agent: 'claude', fallback: true, scope: 'all', maxFixRounds: 1 } });
	const log2: string[] = [];
	addTask(s2.cfg, s2.store, { project: 'p', title: '改 a', spec: 's', agent: 'dsh' });
	await new Runner({ cfg: s2.cfg, store: s2.store, adapters: { dsh: fake('dsh', {}, log2), claude: fake('claude', {}, log2) }, log: () => {} }).drain();
	assert.deepEqual(log2, ['dsh:work']);
});
