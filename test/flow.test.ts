import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Adapter, AgentRunInput, AgentRunResult } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { git } from '../src/git.ts';
import { Runner } from '../src/runner.ts';

const GIT = process.env.DISPATCHER_GIT ?? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');

async function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
	const repo = path.join(root, 'repo');
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
	fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'export const add = () => 0;\n');
	fs.writeFileSync(
		path.join(repo, 'test', 'add.test.js'),
		"import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/add.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
	);
	await git(GIT, repo, ['init', '-b', 'main']);
	await git(GIT, repo, ['add', '-A']);
	await git(GIT, repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
	const cfg: Config = {
		workRoot: path.join(root, 'work'),
		git: GIT,
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 2, maxAttempts: 2, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1_000_000 } },
		projects: { p: { repo, baseBranch: 'main', gates: [{ name: '单元测试', cmd: 'node --test', timeoutMinutes: 1 }] } },
	};
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	const store = new Store(path.join(cfg.workRoot, 'db.sqlite'));
	return { root, repo, cfg, store };
}

function result(over: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		outcome: 'completed',
		errorCode: null,
		errorMessage: null,
		sessionId: 'fake-session',
		finalText: '完成',
		usage: { tokensIn: 100, tokensOut: 20, tokensCacheRead: 50, tokensCacheWrite: 0 },
		violations: [],
		exitCode: 0,
		...over,
	};
}

// 按轮次执行预设动作的假 worker
function fakeAdapter(steps: ((i: AgentRunInput) => Partial<AgentRunResult> | void)[], name = 'dsh'): Adapter & { prompts: string[] } {
	const prompts: string[] = [];
	return {
		name,
		prompts,
		async run(input) {
			prompts.push(input.prompt);
			const step = steps[prompts.length - 1];
			return result(step?.(input) ?? {});
		},
	};
}

const addTask = (store: Store, over: Partial<{ allow: string[]; readonly: string[]; maxAttempts: number }> = {}) =>
	store.createTask({
		project: 'p',
		title: '实现 add',
		spec: '让测试通过',
		allow: over.allow ?? ['src/**'],
		readonly: over.readonly ?? ['test/**'],
		agent: 'dsh',
		maxAttempts: over.maxAttempts ?? 2,
	});

test('第一轮验收失败，第二轮在同一工作区续聊修好并提交', async () => {
	const { cfg, store } = await setup();
	const adapter = fakeAdapter([
		(i) => fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n'),
		(i) => fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n'),
	]);
	const id = addTask(store);
	const runner = new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} });
	await runner.drain();

	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed', t.reason ?? '');
	assert.equal(t.attempts, 2);
	assert.match(adapter.prompts[0], /实现 add/);
	assert.match(adapter.prompts[1], /验收没有通过/);
	const log = await git(cfg.git, t.worktree!, ['log', '--format=%an|%s', '-1']);
	assert.match(log, /^dsh worker\|\[dsh\] #\d+ 实现 add/);
	assert.equal(store.usageToday('dsh').tokensIn, 200);
});

test('改了只读的测试文件：判不通过，用完轮次后交给人，保留现场', async () => {
	const { cfg, store } = await setup();
	const cheat = (i: AgentRunInput) => {
		fs.writeFileSync(path.join(i.worktree, 'test', 'add.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
	};
	const id = addTask(store);
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeAdapter([cheat, cheat]) }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.match(t.last_report ?? '', /只读/);
	assert.match(t.last_report ?? '', /单元测试：已跳过/);
	const log = await git(cfg.git, t.worktree!, ['log', '--format=%s', '-1']);
	assert.match(log, /未通过/);
});

test('环境错误不消耗重试次数', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store);
	const adapter = fakeAdapter([() => ({ outcome: 'error', errorCode: 'INVALID_CREDENTIAL', errorMessage: 'bad key' })]);
	const runner = new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.equal(t.attempts, 0);
	assert.match(t.reason ?? '', /INVALID_CREDENTIAL/);
});

test('审计终止的任务直接交给人，不跑验收', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store);
	const adapter = fakeAdapter([
		() => ({ outcome: 'killed', violations: [{ level: 'escalation', reason: 'worker 申请提升权限：danger-full-access' }] }),
	]);
	const runner = new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.match(t.reason ?? '', /审计终止.*提升权限/);
	assert.equal(store.attemptsFor(id)[0].gate_report, null);
});

test('并发上限：concurrency=2 时同时最多跑 2 个', async () => {
	const { cfg, store } = await setup();
	let running = 0;
	let peak = 0;
	const adapter: Adapter = {
		name: 'dsh',
		async run(i) {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 50));
			fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
			running--;
			return result();
		},
	};
	for (let k = 0; k < 4; k++) addTask(store);
	const runner = new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} });
	await runner.drain();
	assert.equal(peak, 2);
	const bad = store.listTasks().filter((t) => t.status !== 'passed');
	assert.deepEqual(bad.map((t) => `#${t.id} ${t.status} ${t.reason}`), []);
});

const wrong = (i: AgentRunInput) => {
	fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a * b;\n');
};
const right = (i: AgentRunInput) => {
	fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
};

test('DSH 两轮没过：自动升级给 Claude，Claude 在原工作区上接手并通过', async () => {
	const { cfg, store } = await setup();
	const dsh = fakeAdapter([wrong, wrong], 'dsh');
	const claude = fakeAdapter([right], 'claude');
	const id = addTask(store);
	const runner = new Runner({ cfg, store, adapters: { dsh, claude }, log: () => {} });
	await runner.drain();

	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed', t.reason ?? '');
	assert.equal(t.agent, 'claude');
	assert.equal(t.handoff_from, 'dsh');
	assert.equal(t.attempts, 3);
	assert.equal(dsh.prompts.length, 2);
	assert.equal(claude.prompts.length, 1);
	// Claude 第一轮拿到的是交接说明，不是续聊 DSH 的会话
	assert.match(claude.prompts[0], /交接说明/);
	assert.match(claude.prompts[0], /之前由 dsh 处理/);
	const log = await git(cfg.git, t.worktree!, ['log', '--format=%an|%s']);
	assert.match(log.split('\n')[0], /^claude worker\|\[claude\]/);
	assert.match(log, /\[dsh\]\[未通过\]/);
	const agents = store.attemptsFor(id).map((a) => a.agent);
	assert.deepEqual(agents, ['dsh', 'dsh', 'claude']);
});

test('升级链走完仍未通过：交给人', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store, { maxAttempts: 1 });
	cfg.agents.claude = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 };
	const runner = new Runner({
		cfg,
		store,
		adapters: { dsh: fakeAdapter([wrong], 'dsh'), claude: fakeAdapter([wrong], 'claude') },
		log: () => {},
	});
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.equal(t.agent, 'claude');
	assert.match(t.reason ?? '', /升级链已走完/);
});

test('Claude 额度用完：不计轮次，任务放回队列，Claude 暂停到恢复时间', async () => {
	const { cfg, store } = await setup();
	const id = store.createTask({ project: 'p', title: '复核', spec: 's', allow: ['src/**'], readonly: [], agent: 'claude', maxAttempts: 2 });
	const resetAt = new Date(Date.now() + 3600_000).toISOString();
	const claude = fakeAdapter([() => ({ outcome: 'error', errorCode: 'QUOTA_EXHAUSTED', errorMessage: 'usage limit reached', resetAt })], 'claude');
	const runner = new Runner({ cfg, store, adapters: { claude }, log: () => {} });
	await runner.drain();

	const t = store.getTask(id)!;
	assert.equal(t.status, 'queued');
	assert.equal(t.stage_attempts, 0);
	assert.match(t.reason ?? '', /额度用完/);
	assert.equal(store.agentPause('claude')?.until, resetAt);
	// 暂停期间不会再派发
	await runner.drain();
	assert.equal(claude.prompts.length, 1);
});

test('改动里读取凭据：判不通过，而且不执行验收命令', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store, { maxAttempts: 1 });
	const leak = (i: AgentRunInput) => {
		fs.writeFileSync(
			path.join(i.worktree, 'src', 'add.js'),
			"import fs from 'node:fs';\nconst k = fs.readFileSync(process.env.USERPROFILE + '/.codex/auth.json', 'utf8');\nexport const add = (a, b) => a + b;\n",
		);
	};
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeAdapter([leak]) }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.match(t.last_report ?? '', /引用凭据路径/);
	assert.match(t.last_report ?? '', /单元测试：已跳过/);
});

test('通过但有可疑写法：仍算通过，标出来提醒人看', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store);
	const sneaky = (i: AgentRunInput) => {
		fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), '// @ts-ignore\nexport const add = (a, b) => a + b;\n');
	};
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeAdapter([sneaky]) }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.match(t.reason ?? '', /1 处可疑改动/);
	assert.match(t.last_report ?? '', /关闭类型或 lint 检查/);
});

test('额度保护：被挡住的代理不派发，任务留在队列', async () => {
	const { cfg, store } = await setup();
	const id = store.createTask({ project: 'p', title: '复核', spec: 's', allow: [], readonly: [], agent: 'codex', maxAttempts: 1 });
	const codex = fakeAdapter([right], 'codex');
	let blocked = true;
	const runner = new Runner({ cfg, store, adapters: { codex }, quotaBlock: () => (blocked ? '每周额度已用 89%' : null), log: () => {} });
	await runner.drain();
	assert.equal(codex.prompts.length, 0);
	assert.equal(store.getTask(id)?.status, 'queued');
	assert.ok(store.recentEvents(5).some((e) => e.kind === 'quota-guard'));
	blocked = false;
	await runner.drain();
	assert.equal(store.getTask(id)?.status, 'passed');
});

test('模型不可用：不扣轮数，交给人并提示换模型', async () => {
	const { cfg, store } = await setup();
	const id = addTask(store);
	const adapter = fakeAdapter([() => ({ outcome: 'error', errorCode: 'MODEL_UNAVAILABLE', errorMessage: 'unknown model deepseek-old' })]);
	const runner = new Runner({ cfg, store, adapters: { dsh: adapter }, log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.equal(t.attempts, 0);
	assert.match(t.reason ?? '', /模型不可用.*换一个模型/);
});

test('驳回后重试：接着原分支上一版的改动，并把你的意见交给 AI', async () => {
	const { cfg, store } = await setup();
	const { rejectTask, retryTask, archiveTasks } = await import('../src/actions.ts');
	const id = addTask(store);
	let seenFile = '';
	const dsh = fakeAdapter([
		(i) => fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b; // v1\n'),
		(i) => {
			seenFile = fs.readFileSync(path.join(i.worktree, 'src', 'add.js'), 'utf8');
			fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b; // v2\n');
		},
	]);
	const runner = new Runner({ cfg, store, adapters: { dsh }, log: () => {} });
	await runner.drain();
	assert.equal(store.getTask(id)?.status, 'passed');

	await rejectTask(cfg, store, id, '注释要写成中文');
	assert.equal(store.getTask(id)?.feedback, '注释要写成中文');
	await retryTask(cfg, store, id);
	await runner.drain();

	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.match(seenFile, /v1/, '重试时工作区应是上一版');
	assert.match(dsh.prompts[1], /被人驳回/);
	assert.match(dsh.prompts[1], /注释要写成中文/);
	assert.equal(t.feedback, null);
	const log = await git(cfg.git, t.worktree!, ['log', '--format=%s']);
	assert.equal(log.trim().split('\n').length, 3, '初始提交 + v1 + v2');

	// 从头重来：新分支、原始状态，但意见仍会带上
	await rejectTask(cfg, store, id, '换个思路');
	await retryTask(cfg, store, id, { fresh: true });
	const before = store.getTask(id)!.branch;
	const dsh2 = fakeAdapter([(i) => {
		seenFile = fs.readFileSync(path.join(i.worktree, 'src', 'add.js'), 'utf8');
		fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => b + a;\n');
	}]);
	runner.opts.adapters = { dsh: dsh2 };
	await runner.drain();
	assert.match(seenFile, /=> 0/, '从头重来应是原始状态');
	assert.match(dsh2.prompts[0], /原始状态/);
	assert.match(dsh2.prompts[0], /换个思路/);
	assert.notEqual(store.getTask(id)!.branch, before);

	// 清除：只隐藏已结束的任务
	const other = addTask(store);
	assert.equal(archiveTasks(store, { ids: [other] }), '没有可清除的任务');
	await rejectTask(cfg, store, id);
	assert.match(archiveTasks(store, { statuses: ['rejected'] }), /已清除 1 个/);
	assert.ok(!store.listTasks().some((x) => x.id === id));
	assert.ok(store.listTasks(100, true).some((x) => x.id === id));
});

test('实测回归：驳回后重试在原路径重建工作区；AI 出错的一轮不会被误判通过', async () => {
	const { cfg, store } = await setup();
	const { rejectTask, retryTask } = await import('../src/actions.ts');
	const id = addTask(store);
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeAdapter([right]) }, log: () => {} });
	await runner.drain();
	const firstPath = store.getTask(id)!.worktree;
	await rejectTask(cfg, store, id, '再重复做一遍');

	// AI 这一轮出错、什么都没做：工作区里虽然还有上一版，也不能算通过
	const boom = () => ({ outcome: 'error' as const, errorCode: 'ERROR', errorMessage: 'boom' });
	runner.opts.adapters = { dsh: fakeAdapter([boom, boom]) };
	await retryTask(cfg, store, id);
	await runner.drain();
	let t = store.getTask(id)!;
	assert.equal(t.worktree, firstPath, '应在原路径重建');
	assert.notEqual(t.status, 'passed');
	assert.match(t.last_report ?? '', /没有正常完成/);
	assert.equal(t.feedback, '再重复做一遍', '意见没用上，应保留到下一轮');

	assert.equal(t.status, 'needs_human', '两轮都出错，交给人');

	// 会话接不上：换新会话重来，不扣轮数；之后按意见改了东西才通过
	await retryTask(cfg, store, id);
	const before = store.getTask(id)!.stage_attempts;
	const dsh = fakeAdapter([
		() => ({ outcome: 'error', errorCode: 'SESSION_INVALID', errorMessage: 'session "s" was recorded in "a", not "b"' }),
		(i) => fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), 'export const add = (a, b) => a + b; // 重做\n'),
	]);
	runner.opts.adapters = { dsh };
	store.updateTask(id, { session_id: 'fake-session' });
	await runner.drain();
	t = store.getTask(id)!;
	assert.equal(t.status, 'passed', t.reason ?? '');
	assert.equal(t.stage_attempts, before + 1, '会话失效那次不计轮数');
	assert.match(dsh.prompts[1], /再重复做一遍/);
	assert.match(dsh.prompts[1], /保留了上一版的改动/, '换新会话后要给完整说明');
});

test('按意见修改的一轮没有任何新改动：不算通过', async () => {
	const { cfg, store } = await setup();
	const { rejectTask, retryTask } = await import('../src/actions.ts');
	const id = addTask(store, { maxAttempts: 1 });
	const runner = new Runner({ cfg, store, adapters: { dsh: fakeAdapter([right]) }, log: () => {} });
	await runner.drain();
	await rejectTask(cfg, store, id, '改一下注释');
	await retryTask(cfg, store, id);
	runner.opts.adapters = { dsh: fakeAdapter([() => {}]) };
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'needs_human');
	assert.match(t.last_report ?? '', /没有产生任何新改动/);
});

test('Claude、Codex 都被额度保护挡住时：DSH 照常干活；升级过去的任务排队等待，不会失败', async () => {
	const { cfg, store } = await setup();
	const easy = addTask(store);
	const hard = addTask(store, { maxAttempts: 1 });
	let n = 0;
	const dsh: Adapter = {
		name: 'dsh',
		async run(i) {
			n++;
			// 第一个任务做对，第二个任务做错
			const good = i.taskId === easy;
			fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), good ? 'export const add = (a, b) => a + b;\n' : 'export const add = () => 0;\n// x\n');
			return result();
		},
	};
	const claude = fakeAdapter([right], 'claude');
	const codex = fakeAdapter([right], 'codex');
	const runner = new Runner({ cfg, store, adapters: { dsh, claude, codex }, quotaBlock: (a) => (a === 'dsh' ? null : '每周额度只剩 10%'), log: () => {} });
	await runner.drain();
	assert.equal(store.getTask(easy)?.status, 'passed', 'DSH 不受订阅额度影响');
	const h = store.getTask(hard)!;
	assert.equal(h.status, 'queued');
	assert.equal(h.agent, 'claude');
	assert.equal(claude.prompts.length + codex.prompts.length, 0, '被挡住的代理一个任务都没接');
	assert.equal(n, 2);
});

test('互相接管：Claude 被额度挡住、Codex 有余量时，Claude 排队的任务转给 Codex', async () => {
	const { cfg, store } = await setup();
	const id = store.createTask({ project: 'p', title: '复杂任务', spec: 's', allow: ['src/**'], readonly: [], agent: 'claude', maxAttempts: 1 });
	const claude = fakeAdapter([right], 'claude');
	const codex = fakeAdapter([right], 'codex');
	let blocked = new Set(['claude']);
	const runner = new Runner({ cfg, store, adapters: { claude, codex }, quotaBlock: (a) => (blocked.has(a) ? '5 小时额度只剩 5%' : null), log: () => {} });
	await runner.drain();
	const t = store.getTask(id)!;
	assert.equal(t.status, 'passed');
	assert.equal(t.agent, 'codex');
	assert.equal(claude.prompts.length, 0);
	assert.ok(store.recentEvents(20, id).some((e) => e.kind === 'takeover'));

	// 两边都被挡住：不转来转去，原地排队
	const id2 = store.createTask({ project: 'p', title: '等待', spec: 's', allow: [], readonly: [], agent: 'claude', maxAttempts: 1 });
	blocked = new Set(['claude', 'codex']);
	await runner.drain();
	assert.equal(store.getTask(id2)?.agent, 'claude');
	assert.equal(store.getTask(id2)?.status, 'queued');

	// 关掉互相接管：也原地排队
	cfg.takeover = false;
	blocked = new Set(['claude']);
	await runner.drain();
	assert.equal(store.getTask(id2)?.agent, 'claude');
});

test('子代理按代理分开设置：DSH 开、Claude 关；升级给 Claude 后用 Claude 自己的设置', async () => {
	const { cfg, store } = await setup();
	const id = store.createTask({ project: 'p', title: '量大但简单', spec: 's', allow: ['src/**'], readonly: [], agent: 'dsh', maxAttempts: 1, subagentLimits: { dsh: 4 } });
	const seen: Record<string, number | undefined> = {};
	const spy = (name: string, good: boolean): Adapter => ({
		name,
		async run(i) {
			seen[name] = i.subagents;
			fs.writeFileSync(path.join(i.worktree, 'src', 'add.js'), good ? 'export const add = (a, b) => a + b;\n' : 'export const add = () => 0;\n// x\n');
			return result();
		},
	});
	const runner = new Runner({ cfg, store, adapters: { dsh: spy('dsh', false), claude: spy('claude', true) }, log: () => {} });
	await runner.drain();
	assert.equal(store.getTask(id)?.status, 'passed');
	assert.equal(seen.dsh, 4);
	assert.equal(seen.claude, 0, 'Claude 没开子代理');
	assert.deepEqual(store.getTask(id)?.subagent_limits, { dsh: 4 });
});
