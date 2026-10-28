// 命令行和面板共用的操作。所有校验都在这里做，两边行为一致
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dshPaths, launchArgs, PATCHED_IDS, readKey, workerEnv } from './adapters/dsh.ts';
import { resolveClaude, resolveCodex } from './adapters/resolve.ts';
import { agentEnabled, claudeLoggedIn, codexLoggedIn, writePatch } from './agents.ts';
import type { Config, GateCmd, ProjectConfig } from './config.ts';
import { agentLimits, assertWorkRootSafe, DEFAULT_CLAUDE_KEY_FILE, saveConfig, workPaths } from './config.ts';
import type { Store, Task } from './db.ts';
import { git, removeWorktree } from './git.ts';
import { toolStatus } from './tools.ts';

// 子代理共用同一个工作区、各自花 token，开太多反而更慢更贵
export const MAX_SUBAGENTS = 6;

export const STATUS_LABEL: Record<string, string> = {
	queued: '排队',
	running: '运行中',
	gating: '验收中',
	needs_human: '需要你处理',
	passed: '待验收',
	accepted: '已接受',
	rejected: '已驳回',
	cancelled: '已取消',
	failed: '失败',
	merged: '已合并',
	planned: '待批准拆分',
	split: '已拆分',
	reviewing: '复核中',
};

function needTask(store: Store, id: number): Task {
	const t = Number.isFinite(id) ? store.getTask(id) : null;
	if (!t) throw new Error(`找不到任务 #${id}`);
	return t;
}

// 清理工作区目录，但记住路径：之后重试要在同一路径重建，AI 的会话才能接上
async function dropWorktree(cfg: Config, t: Task, store?: Store): Promise<void> {
	const p = cfg.projects[t.project];
	if (p && t.worktree && fs.existsSync(t.worktree)) await removeWorktree(cfg.git, p.repo, t.worktree);
	if (store && t.worktree) store.updateTask(t.id, { last_worktree: t.worktree });
}

export type NewTask = {
	project: string;
	title: string;
	spec: string;
	allow?: string[];
	readonly?: string[];
	agent?: string;
	maxAttempts?: number;
	// 每家各自的子代理上限（0～6），例如 { dsh: 4 }；没写的家不允许
	subagentLimits?: Record<string, number>;
	// 先拆分成小任务：agent 是负责拆分的 AI；childAgent、subagentLimits、autoMerge 留给拆出的子任务
	split?: { childAgent?: string; autoMerge?: boolean };
};

export function addTask(cfg: Config, store: Store, input: NewTask): number {
	const title = input.title?.trim();
	const spec = input.spec?.trim();
	if (!input.project || !title || !spec) throw new Error('项目、标题和任务说明都要填写');
	if (!cfg.projects[input.project]) throw new Error(`未知项目 ${input.project}，已登记：${Object.keys(cfg.projects).join(', ') || '无'}`);
	// auto = 先判断难度再分配（判断完会改成具体的代理）
	const agent = input.agent || 'dsh';
	if (agent !== 'auto' && !agentEnabled(cfg, agent)) throw new Error(`代理 ${agent} 未启用`);
	const maxAttempts = input.maxAttempts && input.maxAttempts > 0 ? Math.min(5, Math.floor(input.maxAttempts)) : agentLimits(cfg, agent === 'auto' ? 'dsh' : agent).maxAttempts;
	const clean = (xs?: string[]) => (xs ?? []).map((s) => s.trim()).filter(Boolean);
	const subagentLimits: Record<string, number> = {};
	for (const a of ['dsh', 'claude', 'codex']) {
		const n = Math.max(0, Math.min(MAX_SUBAGENTS, Math.floor(Number(input.subagentLimits?.[a]) || 0)));
		if (n > 0) subagentLimits[a] = n;
	}
	if (input.split) {
		const childAgent = input.split.childAgent || 'dsh';
		if (childAgent !== 'auto' && !agentEnabled(cfg, childAgent)) throw new Error(`代理 ${childAgent} 未启用`);
		if (agent === 'auto') throw new Error('拆分要指定由哪个 AI 来拆');
		// 拆分只读代码，不需要子代理；子代理设置留给拆出的子任务
		const id = store.createTask({ project: input.project, title, spec, allow: clean(input.allow), readonly: clean(input.readonly), agent, maxAttempts });
		store.updateTask(id, { kind: 'plan', child_agent: childAgent, child_subagent_limits: subagentLimits, auto_merge: input.split.autoMerge ? 1 : 0 });
		store.addEvent(id, null, 'info', 'created', `新的大任务：${title}（由 ${agent} 拆分，小任务默认交给 ${childAgent}）`);
		return id;
	}
	const id = store.createTask({ project: input.project, title, spec, allow: clean(input.allow), readonly: clean(input.readonly), agent, maxAttempts, subagentLimits });
	store.addEvent(id, null, 'info', 'created', `新任务：${title}（交给 ${agent}）`);
	return id;
}

export async function acceptTask(cfg: Config, store: Store, id: number): Promise<string> {
	const t = needTask(store, id);
	if (t.status !== 'passed') throw new Error(`只有“待验收”的任务可以接受，当前是 ${STATUS_LABEL[t.status]}`);
	await dropWorktree(cfg, t, store);
	store.updateTask(t.id, { status: 'accepted', worktree: null, reason: null });
	store.addEvent(t.id, null, 'info', 'accepted', '你已接受');
	// 合并到主分支由人执行：调度器从不改动你正在用的工作目录
	return `已接受 #${t.id}。分支 ${t.branch} 保留，之后可以在任务详情里点“合并到项目”（会先复检，可撤销）`;
}

export async function rejectTask(cfg: Config, store: Store, id: number, reason?: string): Promise<string> {
	const t = needTask(store, id);
	if (['running', 'gating', 'reviewing'].includes(t.status)) throw new Error('任务正在运行或复核，请先取消');
	await dropWorktree(cfg, t, store);
	const why = reason?.trim() || '你已驳回';
	// 写了原因就记下来，重试时交给 AI；分支保留，重试时可以接着这一版改
	store.updateTask(t.id, { status: 'rejected', worktree: null, reason: why, feedback: reason?.trim() || null });
	store.addEvent(t.id, null, 'info', 'rejected', why);
	return `已驳回 #${t.id}。可以在“已驳回”一栏点“重试”，AI 会按你的意见在这一版基础上修改`;
}

export async function retryTask(cfg: Config, store: Store, id: number, opts: { fresh?: boolean; agent?: string } = {}): Promise<string> {
	const t = needTask(store, id);
	if (['running', 'gating', 'queued', 'reviewing'].includes(t.status)) throw new Error('任务还在队列、运行或复核中');
	const agent = opts.agent || t.agent;
	if (agent !== 'auto' && !agentEnabled(cfg, agent)) throw new Error(`代理 ${agent} 未启用`);
	if (opts.fresh) {
		await dropWorktree(cfg, t, store);
		store.updateTask(t.id, { worktree: null, last_worktree: null, base_sha: null, session_id: null, last_report: null, handoff_from: null });
	}
	if (agent !== t.agent) {
		// 换人接手：不续用原代理的会话，第一轮带交接说明
		store.updateTask(t.id, { agent, session_id: null, handoff_from: opts.fresh ? null : t.agent });
	}
	store.updateTask(t.id, {
		status: 'queued',
		archived: 0,
		// 重新跑过的任务结束后要再整理一次；复核返工次数重新计
		tidied: 0,
		review_rounds: 0,
		reason: opts.fresh ? '重新开始' : '你要求重试',
		stage_attempts: 0,
		max_attempts: agentLimits(cfg, agent === 'auto' ? 'dsh' : agent).maxAttempts,
	});
	store.addEvent(t.id, null, 'info', 'retry', `${opts.fresh ? '从基线重新开始' : '在原工作区上继续'}，由 ${agent} 处理`);
	return `#${t.id} 已重新排队，由 ${agent} 处理${opts.fresh ? '（新工作区）' : ''}`;
}

export async function cancelTask(cfg: Config, store: Store, id: number): Promise<string> {
	const t = needTask(store, id);
	if (['accepted', 'rejected', 'cancelled', 'merged'].includes(t.status)) throw new Error(`任务已经是“${STATUS_LABEL[t.status]}”`);
	// 取消大任务：还没结束的子任务一起取消，已合并、已接受的保留
	if (t.kind === 'plan') {
		for (const k of store.childrenOf(t.id)) if (!ENDED.includes(k.status)) await cancelTask(cfg, store, k.id);
	}
	const running = ['running', 'gating', 'reviewing'].includes(t.status);
	store.updateTask(t.id, { status: 'cancelled', reason: '你已取消' });
	store.addEvent(t.id, null, 'info', 'cancelled', '你已取消');
	if (!running) await dropWorktree(cfg, t, store);
	return `#${t.id} 已取消${running ? '，运行中的 AI 会在几秒内被停止' : ''}`;
}

const ENDED = ['accepted', 'rejected', 'cancelled', 'merged'];

// 从看板清除：只隐藏，任务记录、日志、分支都保留。只接受已经结束的任务
export function archiveTasks(store: Store, opts: { ids?: number[]; statuses?: string[] }): string {
	const statuses = (opts.statuses ?? ENDED).filter((s) => ENDED.includes(s));
	const ids = opts.ids?.length ? opts.ids : store.listTasks(10_000).filter((t) => statuses.includes(t.status)).map((t) => t.id);
	const n = store.archive(ids);
	if (n) store.addEvent(null, null, 'info', 'archive', `从看板清除了 ${n} 个已结束的任务`);
	return n ? `已清除 ${n} 个任务（记录和分支仍保留）` : '没有可清除的任务';
}

export type CheckItem = { ok: boolean; msg: string };

// 只检查环境和登录状态，不调用模型、不消耗额度
export function runChecks(cfg: Config): CheckItem[] {
	const wp = workPaths(cfg);
	const out: CheckItem[] = [];
	const report = (ok: boolean, msg: string) => out.push({ ok, msg });

	const major = Number(process.versions.node.split('.')[0]);
	report(major >= 24, `Node ${process.version}（需要 24 以上）`);

	const g = spawnSync(cfg.git, ['--version'], { encoding: 'utf8', windowsHide: true });
	report(g.status === 0, g.status === 0 ? g.stdout.trim() : `找不到 git：${cfg.git}`);

	// 调度器 tools 目录里的工具：没装不算错，只是用到它们的项目跑不起来
	for (const t of toolStatus()) report(true, `${t.name}：${t.ok ? `已安装（${t.where}）` : '未安装（项目需要时再装）'}`);

	try {
		assertWorkRootSafe(cfg);
		report(true, `工作区 ${cfg.workRoot} 不在临时目录内`);
	} catch (e) {
		report(false, String(e instanceof Error ? e.message : e));
	}

	// DSH 的 Windows 沙盒要在工作区上授予写入权限，前提是当前用户对它有完全控制。
	// 用户目录默认满足；其他盘符继承的通常只有“修改”，命令工具会报 SetNamedSecurityInfoW 5
	if (process.platform === 'win32' && fs.existsSync(cfg.workRoot)) {
		const me = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
		const r = spawnSync('icacls', [cfg.workRoot], { encoding: 'utf8', windowsHide: true });
		const lines = (r.stdout ?? '').toLowerCase().split('\n');
		const ok = r.status === 0 && lines.some((l) => l.includes(`${me.toLowerCase()}:`) && l.includes('(oi)(ci)') && l.includes('(f)'));
		report(
			ok,
			ok
				? '工作区对你有完全控制权限（DSH 沙盒运行命令需要）'
				: `工作区缺少你的“完全控制”权限，DSH 将无法运行命令。请自己运行：icacls "${cfg.workRoot}" /grant "${me}:(OI)(CI)F"`,
		);
	}

	const dp = dshPaths(cfg.agents.dsh.install);
	report(fs.existsSync(dp.exe) && fs.existsSync(dp.asar), `DSH 安装：${cfg.agents.dsh.install}`);

	const keyFile = path.join(cfg.workRoot, cfg.agents.dsh.keyFile);
	if (fs.existsSync(keyFile)) {
		const k = readKey(keyFile);
		report(k.startsWith('sk-') && k.length >= 30, `DeepSeek key 文件存在（长度 ${k.length}，内容不显示）`);
	} else {
		report(false, `缺少 DeepSeek key 文件 ${keyFile}`);
	}

	if (fs.existsSync(dp.exe)) {
		const patch = writePatch(cfg);
		const home = path.join(wp.dshHome, '_check');
		fs.mkdirSync(home, { recursive: true });
		const { exe, args } = launchArgs(cfg.agents.dsh.install, patch, null);
		const dumpArgs = [...args.slice(0, args.indexOf('--json')), '--dump-config'];
		const r = spawnSync(exe, dumpArgs, { encoding: 'utf8', windowsHide: true, env: workerEnv({ ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }) });
		const text = r.stdout ?? '';
		const off = PATCHED_IDS.filter((id) => new RegExp(`^- id: ${id}\\r?\\n(?:  .*\\r?\\n)*?  disabled: true`, 'm').test(text));
		report(r.status === 0 && off.length === PATCHED_IDS.length, `DSH 安全补丁生效：已关闭 ${off.join(', ') || '（无）'}`);
		const model = cfg.agents.dsh.model;
		if (model) {
			const applied = new RegExp(`^- id: agent-default-model\\r?\\n(?:  .*\\r?\\n)*?    model: ${model.replace(/[.]/g, '\\.')}\\r?$`, 'm').test(text);
			report(applied, applied ? `DSH 使用模型 ${model}` : `DSH 模型设置 ${model} 没有生效`);
		}
	}

	const claude = cfg.agents.claude;
	if (claude?.enabled) {
		const exe = resolveClaude(claude.command);
		if (!exe || !fs.existsSync(exe)) report(false, 'Claude：找不到 claude.exe');
		else {
			const logged = claudeLoggedIn(exe);
			report(logged, logged ? `Claude 已登录（${exe}）` : `Claude 命令行未登录：请运行 "${exe}" auth login`);
		}
		if (claude.usePaid && claude.paidMethod === 'api_key') {
			const keyFile = path.join(cfg.workRoot, claude.apiKeyFile ?? DEFAULT_CLAUDE_KEY_FILE);
			report(fs.existsSync(keyFile), fs.existsSync(keyFile) ? 'Claude 付费模式的 API Key 已放好（内容不显示）' : `Claude 付费模式选了 API Key，但缺少 key 文件 ${keyFile}`);
		}
	}
	const codex = cfg.agents.codex;
	if (codex?.enabled) {
		const exe = resolveCodex(codex.command);
		if (!exe || !fs.existsSync(exe)) report(false, 'Codex：找不到 codex.exe');
		else {
			const { ok, text } = codexLoggedIn(exe);
			report(ok, ok ? `Codex 已登录（${text}）` : `Codex 未登录：请运行 "${exe}" login`);
		}
	}

	for (const [name, p] of Object.entries(cfg.projects)) {
		const ok = fs.existsSync(p.repo) && spawnSync(cfg.git, ['-C', p.repo, 'rev-parse', '--verify', p.baseBranch], { windowsHide: true }).status === 0;
		report(ok, `项目 ${name}：${p.repo}（${p.baseBranch}），验收 ${p.gates.map((x) => x.name).join(' / ') || '仅路径检查'}`);
	}
	return out;
}

export type NewProject = {
	name: string;
	repo: string;
	baseBranch?: string;
	gates?: GateCmd[];
	setup?: GateCmd[];
	selfCheck?: string;
	protected?: string[];
	upstream?: { repo?: string; branch?: string };
};

// 登记一个已有的 git 仓库。只读检查，不改动仓库
export function saveProject(cfg: Config, input: NewProject): string {
	const name = input.name?.trim();
	if (!name || !/^[\w.-]+$/.test(name)) throw new Error('项目名只能用英文字母、数字、点、横线和下划线');
	const repo = input.repo?.trim();
	if (!repo || !path.isAbsolute(repo) || !fs.existsSync(repo)) throw new Error('仓库路径必须是已存在的绝对路径');
	const baseBranch = input.baseBranch?.trim() || 'main';
	const ok = spawnSync(cfg.git, ['-C', repo, 'rev-parse', '--verify', `${baseBranch}^{commit}`], { windowsHide: true }).status === 0;
	if (!ok) throw new Error(`${repo} 不是 git 仓库，或没有分支 ${baseBranch}`);
	const cmds = (xs?: GateCmd[]) => (xs ?? []).map((g) => ({ name: g.name.trim(), cmd: g.cmd.trim(), timeoutMinutes: g.timeoutMinutes })).filter((g) => g.name && g.cmd);
	const gates = cmds(input.gates);
	const setup = cmds(input.setup);
	// 同步目标：可以是本机路径（必须是 git 仓库）或远程地址；分支名只允许常见字符
	const upRepo = input.upstream?.repo?.trim() ?? '';
	const upBranch = input.upstream?.branch?.trim() || 'main';
	if (upRepo) {
		if (!/^[\w./-]+$/.test(upBranch) || upBranch.includes('..')) throw new Error('同步目标的分支名只能用字母、数字和 . / - _');
		const local = path.isAbsolute(upRepo);
		if (local && !fs.existsSync(upRepo)) throw new Error(`同步目标 ${upRepo} 不存在`);
		if (local && path.resolve(upRepo).toLowerCase() === path.resolve(repo).toLowerCase()) throw new Error('同步目标不能是调度器自己的项目仓库');
		if (!local && !/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(upRepo)) throw new Error('同步目标要么是本机的绝对路径，要么是 https:// / ssh:// / git@ 开头的远程地址');
	}
	const project: ProjectConfig = {
		...(cfg.projects[name] ?? {}),
		repo,
		baseBranch,
		gates,
		setup: setup.length ? setup : undefined,
		upstream: upRepo ? { repo: upRepo, branch: upBranch } : undefined,
		selfCheck: input.selfCheck?.trim() || undefined,
		protected: (input.protected ?? []).map((s) => s.trim()).filter(Boolean),
	};
	cfg.projects[name] = project;
	saveConfig(cfg);
	return `已保存项目 ${name}`;
}

const DEMO_FILES: Record<string, string> = {
	'package.json': '{\n\t"name": "dispatcher-demo",\n\t"private": true,\n\t"type": "module"\n}\n',
	'src/text.js': `// 演示用：调度器会把下面两个函数交给 worker 实现

/**
 * 把标题转成 URL 片段：转小写，空白和下划线换成 "-"，去掉其他标点，合并连续的 "-"，去掉首尾的 "-"。
 * 中文等非 ASCII 字母保留。
 */
export function slugify(title) {
	throw new Error('未实现');
}

/**
 * 统计词数：英文按空白分词，每个汉字算一个词，标点不算。
 */
export function countWords(text) {
	throw new Error('未实现');
}
`,
	'test/text.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, slugify } from '../src/text.js';

test('slugify', () => {
	assert.equal(slugify('Hello World'), 'hello-world');
	assert.equal(slugify('  Multiple   spaces__and_underscores '), 'multiple-spaces-and-underscores');
	assert.equal(slugify('Rust & Go: 2026!'), 'rust-go-2026');
	assert.equal(slugify('中文 标题'), '中文-标题');
	assert.equal(slugify('---'), '');
});

test('countWords', () => {
	assert.equal(countWords('hello world'), 2);
	assert.equal(countWords('  spaced   out  '), 2);
	assert.equal(countWords('你好世界'), 4);
	assert.equal(countWords('Hello，世界！'), 3);
	assert.equal(countWords(''), 0);
});
`,
};

export async function createDemo(cfg: Config): Promise<string> {
	const dir = path.join(workPaths(cfg).projects, 'demo');
	if (!fs.existsSync(path.join(dir, '.git'))) {
		for (const [rel, content] of Object.entries(DEMO_FILES)) {
			const f = path.join(dir, rel);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, content, 'utf8');
		}
		await git(cfg.git, dir, ['init', '-b', 'main']);
		await git(cfg.git, dir, ['add', '-A']);
		await git(cfg.git, dir, ['-c', 'user.name=dispatcher', '-c', 'user.email=dispatcher@dispatcher.local', 'commit', '-m', '演示项目初始版本']);
	}
	cfg.projects.demo ??= {
		repo: dir,
		baseBranch: 'main',
		gates: [{ name: '单元测试', cmd: 'node --test', timeoutMinutes: 2 }],
		selfCheck: 'node --test --experimental-test-isolation=none',
		maxFilesChanged: 5,
		maxLinesChanged: 200,
	};
	saveConfig(cfg);
	return `演示项目已就绪：${dir}`;
}
