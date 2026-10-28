import { DatabaseSync } from 'node:sqlite';
import { localMidnightIso, nowIso } from './util.ts';

export type TaskStatus =
	| 'queued'
	| 'running'
	| 'gating'
	| 'passed'
	| 'needs_human'
	| 'failed'
	| 'accepted'
	| 'rejected'
	| 'cancelled'
	// 已合并进项目的基线分支
	| 'merged'
	// 拆分任务：AI 给出了拆分方案，等你批准
	| 'planned'
	// 拆分任务：已批准、子任务在进行
	| 'split'
	// 验收通过，等另一个 AI 复核（排队或进行中）
	| 'reviewing';

// 某家代理在这个任务里最多能派几个子代理；没设置就是 0（不允许）
export function subagentLimit(task: Pick<Task, 'subagent_limits'>, agent: string): number {
	const n = Number(task.subagent_limits?.[agent] ?? 0);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export const ACTIVE_STATUSES: TaskStatus[] = ['running', 'gating'];

export type Task = {
	id: number;
	project: string;
	title: string;
	spec: string;
	allow: string[];
	readonly: string[];
	agent: string;
	status: TaskStatus;
	// attempts 是所有代理累计的轮数；stage_attempts 是当前代理已用的轮数，升级后清零
	attempts: number;
	stage_attempts: number;
	max_attempts: number;
	branch: string | null;
	worktree: string | null;
	base_sha: string | null;
	session_id: string | null;
	dsh_home: string | null;
	// 从哪个代理升级过来的，新代理第一轮要看交接说明
	handoff_from: string | null;
	// 你驳回时写的意见，下一轮交给 AI 后清空
	feedback: string | null;
	// 1 表示已从看板清除（记录、日志、分支都保留）
	archived: number;
	// 工作区被清理前的路径。重试时原样重建：DSH / Claude 的会话绑定了当时的目录，换目录就接不上
	last_worktree: string | null;
	// 旧字段：以前三家共用一个上限。保留只为读旧数据，新代码一律用 subagent_limits
	subagents: number;
	// 每家各自的子代理上限，例如 { dsh: 4, claude: 0, codex: 0 }；没写的按 0（不允许）
	subagent_limits: Record<string, number>;
	// 合并进项目时生成的合并提交；撤销合并时用
	merge_sha: string | null;
	// task = 普通任务；plan = 先让 AI 拆成小任务的大任务
	kind: string;
	// 由哪个拆分任务派生出来
	parent_id: number | null;
	// 要等这些任务合并进项目后才开始
	depends_on: number[];
	// 拆分方案（JSON），以及子任务交给谁、子代理设置
	plan_json: string | null;
	child_agent: string | null;
	child_subagent_limits: Record<string, number>;
	// 1 = 验收通过后自动合并进项目（拆分出的子任务可选；拆分任务本身记录给子任务的默认值）
	auto_merge: number;
	// 1 = 结束后已整理过（日志压缩、DSH 会话目录删除）
	tidied: number;
	// 难度判断结果（JSON：by / agent / difficulty / reason）
	triage: string | null;
	// 最近一次复核结果（JSON：by / verdict / summary / issues）
	review: string | null;
	// 因复核意见返工过几次
	review_rounds: number;
	// feedback 是谁给的：null = 你；否则是复核的 AI
	feedback_by: string | null;
	// 导出补丁 / 推送到你仓库的记录（JSON）
	export_info: string | null;
	last_report: string | null;
	reason: string | null;
	created_at: string;
	updated_at: string;
};

export type Attempt = {
	id: number;
	task_id: number;
	n: number;
	agent: string;
	started_at: string;
	ended_at: string | null;
	outcome: string | null;
	error_code: string | null;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_read: number;
	log_path: string;
	final_text: string | null;
	gate_report: string | null;
};

export type EventRow = {
	id: number;
	task_id: number | null;
	attempt_id: number | null;
	ts: string;
	level: string;
	kind: string;
	message: string;
};

const SCHEMA = `
create table if not exists tasks (
	id integer primary key autoincrement,
	project text not null,
	title text not null,
	spec text not null,
	allow text not null default '[]',
	readonly text not null default '[]',
	agent text not null,
	status text not null,
	attempts integer not null default 0,
	max_attempts integer not null,
	branch text,
	worktree text,
	base_sha text,
	session_id text,
	dsh_home text,
	last_report text,
	reason text,
	created_at text not null,
	updated_at text not null
);
create table if not exists attempts (
	id integer primary key autoincrement,
	task_id integer not null references tasks(id),
	n integer not null,
	agent text not null,
	started_at text not null,
	ended_at text,
	outcome text,
	error_code text,
	tokens_in integer not null default 0,
	tokens_out integer not null default 0,
	tokens_cache_read integer not null default 0,
	log_path text not null,
	final_text text,
	gate_report text
);
create table if not exists events (
	id integer primary key autoincrement,
	task_id integer,
	attempt_id integer,
	ts text not null,
	level text not null,
	kind text not null,
	message text not null
);
create table if not exists agent_state (
	agent text primary key,
	paused_until text,
	reason text,
	updated_at text not null
);
create index if not exists idx_tasks_status on tasks(status, agent, id);
create index if not exists idx_attempts_agent_time on attempts(agent, started_at);
`;

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
	return {
		...(r as unknown as Task),
		allow: JSON.parse(String(r.allow)),
		readonly: JSON.parse(String(r.readonly)),
		subagent_limits: JSON.parse(String(r.subagent_limits ?? '{}')),
		depends_on: JSON.parse(String(r.depends_on ?? '[]')),
		child_subagent_limits: JSON.parse(String(r.child_subagent_limits ?? '{}')),
		kind: String(r.kind ?? 'task'),
	};
}

const UPDATABLE = new Set([
	'status',
	'agent',
	'attempts',
	'stage_attempts',
	'max_attempts',
	'branch',
	'worktree',
	'base_sha',
	'session_id',
	'dsh_home',
	'handoff_from',
	'feedback',
	'archived',
	'last_worktree',
	'subagents',
	'subagent_limits',
	'merge_sha',
	'plan_json',
	'depends_on',
	'parent_id',
	'kind',
	'child_agent',
	'child_subagent_limits',
	'auto_merge',
	'tidied',
	'triage',
	'review',
	'review_rounds',
	'feedback_by',
	'export_info',
	'last_report',
	'reason',
]);

export class Store {
	db: DatabaseSync;

	constructor(file: string) {
		this.db = new DatabaseSync(file);
		// 调度器、看板、CLI 可能是不同进程同时访问
		this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
		this.db.exec(SCHEMA);
		this.migrate();
	}

	// 旧库缺的列在这里补，避免已有队列数据丢失
	migrate(): void {
		const cols = new Set((this.db.prepare('pragma table_info(tasks)').all() as Row[]).map((r) => String(r.name)));
		if (!cols.has('stage_attempts')) {
			this.db.exec('alter table tasks add column stage_attempts integer not null default 0');
			this.db.exec('update tasks set stage_attempts = attempts');
		}
		if (!cols.has('handoff_from')) this.db.exec('alter table tasks add column handoff_from text');
		if (!cols.has('feedback')) {
			this.db.exec('alter table tasks add column feedback text');
			// 之前驳回时写的原因只存在 reason 里，补进来，重试时也能交给 AI
			this.db.exec(`update tasks set feedback = reason where status = 'rejected' and reason is not null and reason <> '你已驳回'`);
		}
		if (!cols.has('archived')) this.db.exec('alter table tasks add column archived integer not null default 0');
		if (!cols.has('last_worktree')) this.db.exec('alter table tasks add column last_worktree text');
		if (!cols.has('subagents')) this.db.exec('alter table tasks add column subagents integer not null default 0');
		for (const [col, ddl] of [
			['merge_sha', 'text'],
			['kind', "text not null default 'task'"],
			['parent_id', 'integer'],
			['depends_on', "text not null default '[]'"],
			['plan_json', 'text'],
			['child_agent', 'text'],
			['child_subagent_limits', "text not null default '{}'"],
			['auto_merge', 'integer not null default 0'],
			['tidied', 'integer not null default 0'],
			['triage', 'text'],
			['review', 'text'],
			['review_rounds', 'integer not null default 0'],
			['feedback_by', 'text'],
			['export_info', 'text'],
		]) {
			if (!cols.has(col)) this.db.exec(`alter table tasks add column ${col} ${ddl}`);
		}
		if (!cols.has('subagent_limits')) {
			this.db.exec("alter table tasks add column subagent_limits text not null default '{}'");
			// 旧任务的统一上限原样分给三家，行为不变
			this.db.exec(`update tasks set subagent_limits = json_object('dsh', subagents, 'claude', subagents, 'codex', subagents) where subagents > 0`);
		}
		const acols = new Set((this.db.prepare('pragma table_info(attempts)').all() as Row[]).map((r) => String(r.name)));
		if (!acols.has('tokens_cache_write')) this.db.exec('alter table attempts add column tokens_cache_write integer not null default 0');
		const scols = new Set((this.db.prepare('pragma table_info(agent_state)').all() as Row[]).map((r) => String(r.name)));
		if (!scols.has('quota')) {
			this.db.exec('alter table agent_state add column quota text');
			this.db.exec('alter table agent_state add column quota_at text');
		}
		if (!scols.has('quota_source')) this.db.exec('alter table agent_state add column quota_source text');
		if (!scols.has('paid')) this.db.exec('alter table agent_state add column paid text');
		if (!acols.has('paid')) this.db.exec('alter table attempts add column paid integer not null default 0');
		if (!acols.has('cost_usd')) this.db.exec('alter table attempts add column cost_usd real');
	}

	pauseAgent(agent: string, until: string, reason: string): void {
		this.db
			.prepare(
				`insert into agent_state (agent, paused_until, reason, updated_at) values (?, ?, ?, ?)
				 on conflict(agent) do update set paused_until = excluded.paused_until, reason = excluded.reason, updated_at = excluded.updated_at`,
			)
			.run(agent, until, reason, nowIso());
	}

	// 记录最近一次看到的订阅额度窗口；不影响暂停状态
	setAgentQuota(agent: string, quota: unknown, source = '最近一次 Claude 运行'): void {
		this.db
			.prepare(
				`insert into agent_state (agent, quota, quota_at, quota_source, updated_at) values (?, ?, ?, ?, ?)
				 on conflict(agent) do update set quota = excluded.quota, quota_at = excluded.quota_at, quota_source = excluded.quota_source, updated_at = excluded.updated_at`,
			)
			.run(agent, JSON.stringify(quota), nowIso(), source, nowIso());
	}

	agentQuota(agent: string): {
		windows: Record<string, { utilization: number; resetsAt: string }>;
		at: string;
		source: string | null;
		paid: { available: boolean; note: string } | null;
	} | null {
		const r = this.db.prepare('select quota, quota_at, quota_source, paid from agent_state where agent = ?').get(agent) as Row | undefined;
		if (!r?.quota) return null;
		return {
			windows: JSON.parse(String(r.quota)),
			at: String(r.quota_at),
			source: r.quota_source ? String(r.quota_source) : null,
			paid: r.paid ? JSON.parse(String(r.paid)) : null,
		};
	}

	setAgentPaid(agent: string, paid: { available: boolean; note: string }): void {
		this.db
			.prepare(
				`insert into agent_state (agent, paid, updated_at) values (?, ?, ?)
				 on conflict(agent) do update set paid = excluded.paid, updated_at = excluded.updated_at`,
			)
			.run(agent, JSON.stringify(paid), nowIso());
	}

	// 今天在“付费模式”下启动过的运行次数，用于每日上限
	paidRunsToday(agent: string): number {
		const r = this.db.prepare('select count(*) as n from attempts where agent = ? and paid = 1 and started_at >= ?').get(agent, localMidnightIso()) as Row;
		return Number(r.n);
	}

	// 今天付费模式下真实花掉的美元（Claude api_key 方式才有）
	paidCostToday(agent: string): number {
		const r = this.db.prepare('select coalesce(sum(cost_usd), 0) as c from attempts where agent = ? and paid = 1 and started_at >= ?').get(agent, localMidnightIso()) as Row;
		return Number(r.c);
	}

	queuedFor(agent: string): Task[] {
		return (this.db.prepare(`select * from tasks where status = 'queued' and agent = ? and archived = 0 order by id`).all(agent) as Row[]).map(toTask);
	}

	agentPause(agent: string): { until: string; reason: string } | null {
		const r = this.db.prepare('select paused_until, reason from agent_state where agent = ?').get(agent) as Row | undefined;
		if (!r?.paused_until || String(r.paused_until) <= nowIso()) return null;
		return { until: String(r.paused_until), reason: String(r.reason ?? '') };
	}

	close(): void {
		this.db.close();
	}

	createTask(t: {
		project: string;
		title: string;
		spec: string;
		allow: string[];
		readonly: string[];
		agent: string;
		maxAttempts: number;
		subagentLimits?: Record<string, number>;
	}): number {
		const ts = nowIso();
		const r = this.db
			.prepare(
				`insert into tasks (project, title, spec, allow, readonly, agent, status, max_attempts, subagent_limits, created_at, updated_at)
				 values (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
			)
			.run(t.project, t.title, t.spec, JSON.stringify(t.allow), JSON.stringify(t.readonly), t.agent, t.maxAttempts, JSON.stringify(t.subagentLimits ?? {}), ts, ts);
		return Number(r.lastInsertRowid);
	}

	getTask(id: number): Task | null {
		const r = this.db.prepare('select * from tasks where id = ?').get(id) as Row | undefined;
		return r ? toTask(r) : null;
	}

	listTasks(limit = 200, includeArchived = false): Task[] {
		const sql = includeArchived ? 'select * from tasks order by id desc limit ?' : 'select * from tasks where archived = 0 order by id desc limit ?';
		return (this.db.prepare(sql).all(limit) as Row[]).map(toTask);
	}

	withStatus(status: TaskStatus): Task[] {
		return (this.db.prepare('select * from tasks where status = ? and archived = 0 order by id').all(status) as Row[]).map(toTask);
	}

	childrenOf(parentId: number): Task[] {
		return (this.db.prepare('select * from tasks where parent_id = ? order by id').all(parentId) as Row[]).map(toTask);
	}

	// 只清除已经结束的任务；返回实际清除的数量
	archive(ids: number[]): number {
		let n = 0;
		const stmt = this.db.prepare(`update tasks set archived = 1, updated_at = ? where id = ? and archived = 0 and status in ('accepted', 'rejected', 'cancelled', 'merged')`);
		for (const id of ids) n += Number(stmt.run(nowIso(), id).changes);
		return n;
	}

	// 取出并立刻标记为 running，同一进程内不会被重复领取
	// 依赖的任务都已合并进项目，才算可以开始：否则它拿不到前面任务的代码
	dependenciesMet(t: Task): boolean {
		if (!t.depends_on?.length) return true;
		const q = this.db.prepare('select status from tasks where id = ?');
		return t.depends_on.every((id) => (q.get(id) as Row | undefined)?.status === 'merged');
	}

	claimNextQueued(agent: string): Task | null {
		const rows = this.db.prepare(`select * from tasks where status = 'queued' and agent = ? order by id`).all(agent) as Row[];
		const r = rows.map(toTask).find((t) => this.dependenciesMet(t));
		if (!r) return null;
		const changed = this.db
			.prepare(`update tasks set status = 'running', updated_at = ? where id = ? and status = 'queued'`)
			.run(nowIso(), r.id);
		return changed.changes === 1 ? this.getTask(r.id) : null;
	}

	updateTask(id: number, fields: Partial<Task>): void {
		const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
		if (keys.length === 0) return;
		const sets = keys.map((k) => `${k} = ?`).join(', ');
		// 数组 / 对象字段（例如 subagent_limits）以 JSON 存
		const values = keys.map((k) => {
			const v = (fields as Row)[k];
			return (v !== null && typeof v === 'object' ? JSON.stringify(v) : v) as string | number | null;
		});
		this.db.prepare(`update tasks set ${sets}, updated_at = ? where id = ?`).run(...values, nowIso(), id);
	}

	addAttempt(taskId: number, n: number, agent: string, logPath: string, paid = false): number {
		const r = this.db
			.prepare('insert into attempts (task_id, n, agent, started_at, log_path, paid) values (?, ?, ?, ?, ?, ?)')
			.run(taskId, n, agent, nowIso(), logPath, paid ? 1 : 0);
		return Number(r.lastInsertRowid);
	}

	finishAttempt(
		id: number,
		f: {
			outcome: string;
			errorCode?: string | null;
			tokensIn: number;
			tokensOut: number;
			tokensCacheRead: number;
			tokensCacheWrite?: number;
			costUsd?: number | null;
			finalText: string;
		},
	): void {
		this.db
			.prepare(
				`update attempts set ended_at = ?, outcome = ?, error_code = ?, tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, tokens_cache_write = ?, cost_usd = ?, final_text = ? where id = ?`,
			)
			.run(nowIso(), f.outcome, f.errorCode ?? null, f.tokensIn, f.tokensOut, f.tokensCacheRead, f.tokensCacheWrite ?? 0, f.costUsd ?? null, f.finalText, id);
	}

	setAttemptLog(attemptId: number, logPath: string): void {
		this.db.prepare('update attempts set log_path = ? where id = ?').run(logPath, attemptId);
	}

	setGateReport(attemptId: number, report: string): void {
		this.db.prepare('update attempts set gate_report = ? where id = ?').run(report, attemptId);
	}

	attemptsFor(taskId: number): Attempt[] {
		return this.db.prepare('select * from attempts where task_id = ? order by n').all(taskId) as unknown as Attempt[];
	}

	addEvent(taskId: number | null, attemptId: number | null, level: 'info' | 'warn' | 'error', kind: string, message: string): void {
		this.db
			.prepare('insert into events (task_id, attempt_id, ts, level, kind, message) values (?, ?, ?, ?, ?, ?)')
			.run(taskId, attemptId, nowIso(), level, kind, message);
	}

	recentEvents(limit = 50, taskId?: number): EventRow[] {
		if (taskId !== undefined) {
			return this.db
				.prepare('select * from events where task_id = ? order by id desc limit ?')
				.all(taskId, limit) as unknown as EventRow[];
		}
		return this.db.prepare('select * from events order by id desc limit ?').all(limit) as unknown as EventRow[];
	}

	// 缓存命中的 token 单价低得多，所以分开统计；预算按“未命中输入 + 输出”计
	usageToday(agent: string): { tokensIn: number; tokensOut: number; tokensCacheRead: number; attempts: number } {
		const r = this.db
			.prepare(
				`select coalesce(sum(tokens_in),0) as i, coalesce(sum(tokens_out),0) as o, coalesce(sum(tokens_cache_read),0) as c, count(*) as n
				 from attempts where agent = ? and started_at >= ?`,
			)
			.get(agent, localMidnightIso()) as Row;
		return { tokensIn: Number(r.i), tokensOut: Number(r.o), tokensCacheRead: Number(r.c), attempts: Number(r.n) };
	}

	// 调度器崩溃或被关掉时，正在跑的任务没有结果，交给人判断是否重跑
	recoverInterrupted(): number {
		const r = this.db
			.prepare(
				`update tasks set status = 'needs_human', reason = '调度器重启时该任务被中断，请确认后 retry', updated_at = ?
				 where status in ('running', 'gating')`,
			)
			.run(nowIso());
		return Number(r.changes);
	}
}
