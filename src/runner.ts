import fs from 'node:fs';
import path from 'node:path';
import type { Adapter, AgentRunResult } from './adapters/types.ts';
import { ENV_ERROR_CODES } from './adapters/types.ts';
import type { Config, ProjectConfig } from './config.ts';
import { agentLimits, DEFAULT_ESCALATION, DEFAULT_PROTECTED, reviewOf, sensitiveDirs, triageOf, workPaths } from './config.ts';
import type { Store, Task } from './db.ts';
import { subagentLimit } from './db.ts';
import { formatReport, runCommands, runGates } from './gates.ts';
import { attachWorktree, branchExists, changedSince, commitAll, createWorktree, git, headSha, removeWorktree } from './git.ts';
import { mergeTask } from './merge.ts';
import { enabledAgents, extractJson, extractPlan, normalizePlan } from './plan.ts';
import type { DependencyInfo } from './prompts.ts';
import { dependencyNotes, escalationPrompt, feedbackPrompt, firstPrompt, planPrompt, retryPrompt, reviewPrompt, triagePrompt } from './prompts.ts';
import { tail, timestampSlug } from './util.ts';

export type RunnerOptions = {
	cfg: Config;
	store: Store;
	adapters: Record<string, Adapter>;
	// 允许读取的额外目录（各代理的安装目录），由入口填充
	allowedRead?: string[];
	// 返回非空表示该代理因额度原因暂不派发（由入口按订阅额度计算，测试里可注入）
	quotaBlock?: (agent: string) => string | null;
	// 这个代理此刻是否在用付费额度（用于记账和每日上限）
	paidMode?: (agent: string) => boolean;
	log?: (msg: string) => void;
};

const DEFAULT_QUOTA_PAUSE_MINUTES = 30;

const joinWarn = (a: string | null, b: string): string => (a ? `${a}；${b}` : b);

// 这个任务最近一轮有汇报的输出；指定 agent 时只看那家的
function lastReport(store: Store, taskId: number, agent?: string): string | null {
	const a = store
		.attemptsFor(taskId)
		.reverse()
		.find((x) => x.final_text?.trim() && (!agent || x.agent === agent));
	return a?.final_text ?? null;
}

// 互相接管的方向：订阅制的两家可以替代彼此；DSH 只受自己的 token 预算限制，不参与
const TAKEOVER: [string, string][] = [
	['claude', 'codex'],
	['codex', 'claude'],
];

export class Runner {
	opts: RunnerOptions;
	active = new Map<number, { agent: string; abort: AbortController; done: Promise<void> }>();
	timer: NodeJS.Timeout | null = null;
	budgetWarned = new Set<string>();
	quotaWarned = new Map<string, string>();

	constructor(opts: RunnerOptions) {
		this.opts = opts;
	}

	log(msg: string): void {
		(this.opts.log ?? console.log)(`[${new Date().toLocaleTimeString()}] ${msg}`);
	}

	start(intervalMs = 2000): void {
		const n = this.opts.store.recoverInterrupted();
		if (n) this.log(`有 ${n} 个任务在上次退出时被中断，已标为“需要你处理”`);
		this.tick();
		this.timer = setInterval(() => this.tick(), intervalMs);
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		for (const a of this.active.values()) a.abort.abort();
		await Promise.allSettled([...this.active.values()].map((a) => a.done));
	}

	activeCount(agent: string): number {
		let n = 0;
		for (const a of this.active.values()) if (a.agent === agent) n++;
		return n;
	}

	// 只有 DSH 按 token 计费；Claude / Codex 用的是订阅额度，靠“额度用完就暂停”管理
	overBudget(agent: string): boolean {
		if (agent !== 'dsh') return false;
		const limit = this.opts.cfg.agents.dsh.dailyTokenBudget;
		const u = this.opts.store.usageToday(agent);
		const used = u.tokensIn + u.tokensOut;
		if (used < limit) {
			this.budgetWarned.delete(agent);
			return false;
		}
		if (!this.budgetWarned.has(agent)) {
			this.budgetWarned.add(agent);
			this.opts.store.addEvent(null, null, 'warn', 'budget', `${agent} 今日已用 ${used} token，达到上限 ${limit}，暂停派发`);
			this.log(`${agent} 达到今日预算，暂停派发`);
		}
		return true;
	}

	nextAgent(current: string): string | null {
		const chain = (this.opts.cfg.escalation ?? DEFAULT_ESCALATION).filter((a) => this.opts.adapters[a]);
		const i = chain.indexOf(current as (typeof chain)[number]);
		return i >= 0 && i + 1 < chain.length ? chain[i + 1] : null;
	}

	// 代理此刻不能接活的原因（没启用/没登录、额度用完暂停、额度保护），能接活返回 null
	unavailable(agent: string): string | null {
		if (!this.opts.adapters[agent]) return '不可用（未启用或未登录）';
		const pause = this.opts.store.agentPause(agent);
		if (pause) return `额度用完，暂停到 ${new Date(pause.until).toLocaleString()}`;
		return this.opts.quotaBlock?.(agent) ?? null;
	}

	// Claude 和 Codex 一方接不了活、另一方可以时，把排队中的任务转过去（不是失败，不扣轮数）
	takeovers(): void {
		const { cfg, store } = this.opts;
		if (cfg.takeover === false) return;
		for (const [from, to] of TAKEOVER) {
			const why = this.unavailable(from);
			if (!why || this.unavailable(to)) continue;
			for (const t of store.queuedFor(from)) {
				store.updateTask(t.id, {
					agent: to,
					stage_attempts: 0,
					max_attempts: agentLimits(cfg, to).maxAttempts,
					session_id: null,
					// 原代理已经做过几轮，就让接手方看到交接说明；还没开始就沿用原来的交接关系
					handoff_from: t.stage_attempts > 0 ? from : t.handoff_from,
					reason: `${from} ${why}，改由 ${to} 接手`,
				});
				store.addEvent(t.id, null, 'warn', 'takeover', `${from} ${why}，改由 ${to} 接手`);
				this.log(`#${t.id} ${from} 接不了，改由 ${to} 接手`);
			}
		}
	}

	tick(): void {
		const { store } = this.opts;
		// CLI 在另一个进程里取消任务时，只改了数据库，这里负责真正停掉
		for (const [id, a] of this.active) {
			if (store.getTask(id)?.status === 'cancelled') a.abort.abort();
		}
		this.takeovers();
		// 判断难度、复核都很快，先占位置；它们和普通任务共用各家的同时运行数
		this.startTriage();
		this.startReviews();
		for (const [agent, adapter] of Object.entries(this.opts.adapters)) {
			if (store.agentPause(agent)) continue;
			const blocked = this.opts.quotaBlock?.(agent) ?? null;
			if (blocked) {
				// 同一原因只记一次事件，避免每 2 秒刷屏
				if (this.quotaWarned.get(agent) !== blocked) {
					this.quotaWarned.set(agent, blocked);
					store.addEvent(null, null, 'warn', 'quota-guard', `${agent}：${blocked}`);
					this.log(`${agent} ${blocked}`);
				}
				continue;
			}
			this.quotaWarned.delete(agent);
			const limit = agentLimits(this.opts.cfg, agent).concurrency;
			while (this.activeCount(agent) < limit && !this.overBudget(agent)) {
				const task = store.claimNextQueued(agent);
				if (!task) break;
				const abort = new AbortController();
				const done = this.process(task, adapter, abort.signal).finally(() => this.active.delete(task.id));
				this.active.set(task.id, { agent, abort, done });
			}
		}
	}

	// 等所有能派发的任务结束（测试和 run --once 用）；暂停中的代理的任务留在队列里
	async drain(): Promise<void> {
		for (;;) {
			this.tick();
			if (this.active.size === 0) return;
			await Promise.race([...this.active.values()].map((a) => a.done));
		}
	}

	handleQuota(t: Task, agent: string, r: AgentRunResult): void {
		const { cfg, store } = this.opts;
		const minutes = (cfg.agents as Record<string, { quotaPauseMinutes?: number } | undefined>)[agent]?.quotaPauseMinutes ?? DEFAULT_QUOTA_PAUSE_MINUTES;
		const until = r.resetAt && r.resetAt > new Date().toISOString() ? r.resetAt : new Date(Date.now() + minutes * 60_000).toISOString();
		const when = new Date(until).toLocaleString();
		store.pauseAgent(agent, until, r.errorMessage ?? '额度用完');
		// 额度问题不是任务的错：不计轮次，放回队列等恢复
		store.updateTask(t.id, { status: 'queued', reason: `${agent} 额度用完，预计 ${when} 恢复后继续` });
		store.addEvent(t.id, null, 'warn', 'quota', `${agent} 额度用完，暂停到 ${when}：${r.errorMessage ?? ''}`);
		this.log(`${agent} 额度用完，暂停到 ${when}`);
	}

	async process(task: Task, adapter: Adapter, signal: AbortSignal): Promise<void> {
		const { cfg, store } = this.opts;
		const wp = workPaths(cfg);
		const fail = (reason: string, status: Task['status'] = 'needs_human') => {
			store.updateTask(task.id, { status, reason });
			store.addEvent(task.id, null, status === 'failed' ? 'error' : 'warn', status, reason);
			this.log(`#${task.id} ${status === 'needs_human' ? '需要你处理' : '失败'}：${reason}`);
		};
		try {
			const project = cfg.projects[task.project];
			if (!project) return fail(`未知项目 ${task.project}`);
			const protectedGlobs = [...DEFAULT_PROTECTED, ...(project.protected ?? [])];
			const limits = agentLimits(cfg, adapter.name);

			let t = task;
			// 工作区里是不是上一版的改动（驳回、取消后重试时为 true；新任务和“从头重来”为 false）
			let hasPrevWork = true;
			if (!t.worktree || !t.base_sha || !fs.existsSync(t.worktree)) {
				const newDir = path.join(wp.worktrees, `${t.project}-${t.id}-${timestampSlug()}`);
				if (t.base_sha && t.branch && (await branchExists(cfg.git, project.repo, t.branch))) {
					// 驳回或取消时工作区被清理了，但分支还在：在原来的路径重新检出，接着上一版做。
					// 必须是原路径：DSH 会拒绝在别的目录续用会话（实测），Claude 的会话也按目录存放
					const old = t.last_worktree ?? t.worktree;
					const dir = old && !fs.existsSync(old) ? old : newDir;
					await attachWorktree(cfg.git, project.repo, dir, t.branch);
					store.updateTask(t.id, { worktree: dir });
					store.addEvent(t.id, null, 'info', 'worktree', `重新检出分支 ${t.branch}，在上一版的基础上继续`);
				} else {
					hasPrevWork = false;
					const dir = newDir;
					const branch = `task/${t.id}-${timestampSlug()}`;
					const sha = await createWorktree(cfg.git, project.repo, project.baseBranch, dir, branch);
					store.updateTask(t.id, {
						worktree: dir,
						last_worktree: null,
						branch,
						base_sha: sha,
						session_id: null,
						last_report: null,
						handoff_from: null,
						dsh_home: path.join(wp.dshHome, `task-${t.id}`),
					});
					store.addEvent(t.id, null, 'info', 'worktree', `创建工作区 ${dir}（分支 ${branch}）`);
				}
				t = store.getTask(t.id)!;
			}
			// 新副本里没有 node_modules 之类没进 git 的东西：先跑项目的准备命令（每个副本成功跑过一次就不再跑）
			const prep = await this.prepare(t, project, t.worktree!);
			if (prep) return fail(prep);

			const n = t.attempts + 1;
			const stage = t.stage_attempts + 1;
			fs.mkdirSync(wp.logs, { recursive: true });
			const logFile = path.join(wp.logs, `task-${t.id}-a${n}-${adapter.name}-${timestampSlug()}.ndjson`);
			const paid = this.opts.paidMode?.(adapter.name) ?? false;
			const attemptId = store.addAttempt(t.id, n, adapter.name, logFile, paid);
			// 人的驳回意见优先：它说明的是“验收通过了但人不满意”，和自动验收失败的重试是两回事
			// 换了 AI（或会话接不上）时，新会话看不到之前的对话：把上一轮的汇报、前面几项子任务的情况一起交给它
			let prompt =
				t.kind === 'plan'
					? planPrompt(t, project, protectedGlobs, { agents: enabledAgents(cfg), feedback: t.feedback, prevPlan: t.feedback ? t.plan_json : null, problem: t.last_report })
					: t.feedback
						? feedbackPrompt(t, project, protectedGlobs, { feedback: t.feedback, sameSession: Boolean(t.session_id), hasPrevWork, prevAgent: t.handoff_from, prevReport: lastReport(store, t.id), by: t.feedback_by })
						: t.session_id && t.last_report
							? retryPrompt(t, t.last_report)
							: t.handoff_from
								? escalationPrompt(t, project, protectedGlobs, t.handoff_from, t.last_report, lastReport(store, t.id, t.handoff_from))
								: firstPrompt(t, project, protectedGlobs);
			if (t.kind !== 'plan' && !t.session_id && t.depends_on.length) prompt += dependencyNotes(await this.dependencyInfo(t, project.repo));
			this.log(`#${t.id} 第 ${n} 轮开始（${adapter.name} 第 ${stage}/${t.max_attempts} 轮）：${t.title}`);
			const startHead = t.feedback ? await headSha(cfg.git, t.worktree!) : null;

			const r = await adapter.run({
				taskId: t.id,
				worktree: t.worktree!,
				prompt,
				sessionId: t.session_id,
				home: t.dsh_home ?? path.join(wp.dshHome, `task-${t.id}`),
				logFile,
				timeoutMs: limits.timeoutMinutes * 60_000,
				audit: {
					worktree: t.worktree!,
					sensitive: sensitiveDirs(cfg),
					allowedRead: [t.dsh_home ?? '', ...(this.opts.allowedRead ?? [])].filter(Boolean),
				},
				allowCommands: [...project.gates.map((g) => g.cmd), project.selfCheck ?? ''].filter(Boolean),
				paid,
				subagents: subagentLimit(t, adapter.name),
				signal,
				onAudit: (v, tool) => store.addEvent(t.id, attemptId, v.level === 'warn' ? 'warn' : 'error', `audit:${v.level}`, `${tool}：${v.reason}`),
			});
			store.finishAttempt(attemptId, {
				outcome: r.outcome,
				errorCode: r.errorCode,
				tokensIn: r.usage.tokensIn,
				tokensOut: r.usage.tokensOut,
				tokensCacheRead: r.usage.tokensCacheRead,
				tokensCacheWrite: r.usage.tokensCacheWrite,
				costUsd: r.costUsd ?? null,
				finalText: r.finalText,
			});
			if (r.sessionId) store.updateTask(t.id, { session_id: r.sessionId });
			if (r.quota) store.setAgentQuota(adapter.name, r.quota);
			if (r.paid) store.setAgentPaid(adapter.name, r.paid);
			if (r.subagents) {
				const detail = r.subagents.lines.join('\n');
				store.addEvent(t.id, attemptId, 'info', 'subagents', r.subagents.count ? `本轮派了 ${r.subagents.count} 个子代理（用量已计入）：\n${detail}` : `本轮允许子代理，但 ${adapter.name} 没有派`);
			}

			if (r.outcome === 'cancelled') return fail('已取消', 'cancelled');
			if (r.outcome === 'killed') {
				const why = r.violations.filter((v) => v.level === 'block' || v.level === 'escalation').map((v) => v.reason);
				return fail(`审计终止：${why.join('；')}`);
			}
			if (r.outcome === 'error' && r.errorCode === 'QUOTA_EXHAUSTED') return this.handleQuota(t, adapter.name, r);
			if (r.outcome === 'error' && r.errorCode === 'MODEL_UNAVAILABLE') {
				return fail(`${adapter.name} 设置的模型不可用（可能已改名或下线），请在“设置”里换一个模型后点重试：${r.errorMessage ?? ''}`);
			}
			if (r.outcome === 'error' && r.errorCode === 'SESSION_INVALID' && t.session_id) {
				// 会话接不上（例如工作目录变了）：丢掉旧会话，换新会话重来，不算 AI 的失败
				store.updateTask(t.id, { session_id: null, status: 'queued', reason: `${adapter.name} 的旧会话接不上，换新会话重试` });
				store.addEvent(t.id, attemptId, 'warn', 'session', `旧会话无法继续，改用新会话：${r.errorMessage ?? ''}`);
				return;
			}
			if (r.outcome === 'error' && r.errorCode && ENV_ERROR_CODES.has(r.errorCode)) {
				// 环境问题不消耗重试次数
				return fail(`环境问题（${adapter.name} ${r.errorCode}）：${r.errorMessage ?? ''}`);
			}

			// 这一轮没能让 AI 正常完成，或者没有达到验收：同样计入轮数，走重试 / 升级 / 交给人
			const roundFailed = async (text: string) => {
				store.addEvent(t.id, attemptId, 'warn', 'gates', tail(text, 3000));
				if (stage < t.max_attempts) {
					store.updateTask(t.id, { status: 'queued', last_report: text, reason: `${adapter.name} 第 ${stage} 轮未通过，自动重试` });
					this.log(`#${t.id} ${adapter.name} 第 ${stage} 轮未通过，排队重试`);
					return;
				}
				// 保留失败现场：接手的代理或人可以在此基础上继续
				await commitAll(cfg.git, t.worktree!, `[${adapter.name}][未通过] #${t.id} ${t.title}`, `${adapter.name} worker`);
				const next = this.nextAgent(adapter.name);
				if (next) {
					store.updateTask(t.id, {
						agent: next,
						stage_attempts: 0,
						max_attempts: agentLimits(cfg, next).maxAttempts,
						session_id: null,
						handoff_from: adapter.name,
						last_report: text,
						status: 'queued',
						reason: `${adapter.name} ${stage} 轮未通过，已升级给 ${next}`,
					});
					store.addEvent(t.id, attemptId, 'warn', 'escalate', `${adapter.name} 用完 ${stage} 轮仍未通过，升级给 ${next}`);
					this.log(`#${t.id} 升级：${adapter.name} → ${next}`);
					return;
				}
				store.updateTask(t.id, { last_report: text });
				return fail(`${adapter.name} ${stage} 轮未通过验收，升级链已走完，需要你处理`);
			};

			if (r.outcome !== 'completed') {
				// 不拿工作区里已有的东西去跑验收：上一版的成果还在，会让“AI 什么都没做”的一轮被误判通过（实测出现过）
				store.updateTask(t.id, { attempts: n, stage_attempts: stage, status: 'gating' });
				store.addEvent(t.id, attemptId, 'warn', 'agent', `本轮异常结束（${r.outcome} ${r.errorCode ?? ''}）：${r.errorMessage ?? ''}`);
				return roundFailed(`✘ ${adapter.name} 本轮没有正常完成（${r.outcome}${r.errorCode ? ` ${r.errorCode}` : ''}）：${r.errorMessage ?? '无详细信息'}`);
			}

			if (t.kind === 'plan') {
				store.updateTask(t.id, { attempts: n, stage_attempts: stage, status: 'gating' });
				return this.finishPlan(t, project.repo, attemptId, r.finalText, roundFailed);
			}

			// 按驳回意见修改的一轮必须真的改了东西，否则等于原样交回
			if (t.feedback && startHead && !(await changedSince(cfg.git, t.worktree!, startHead))) {
				store.updateTask(t.id, { attempts: n, stage_attempts: stage, status: 'gating' });
				return roundFailed('✘ 按你的意见修改的这一轮没有产生任何新改动');
			}

			// 意见已经交给 AI 并完成了一轮，清掉，免得之后的自动重试重复提起
			store.updateTask(t.id, { attempts: n, stage_attempts: stage, status: 'gating', feedback: null, feedback_by: null });

			const report = await runGates({
				git: cfg.git,
				worktree: t.worktree!,
				baseSha: t.base_sha!,
				allow: t.allow,
				readonly: t.readonly,
				protectedGlobs,
				maxFiles: project.maxFilesChanged ?? 30,
				maxLines: project.maxLinesChanged ?? 2000,
				commands: project.gates,
				cargoTarget: wp.cargoTarget,
			});
			store.setGateReport(attemptId, JSON.stringify(report));
			const text = formatReport(report);

			if (store.getTask(t.id)?.status === 'cancelled') return;
			if (report.ok) {
				const sha = await commitAll(cfg.git, t.worktree!, `[${adapter.name}] #${t.id} ${t.title}`, `${adapter.name} worker`);
				const warn = report.warnings.length ? `通过，但有 ${report.warnings.length} 处可疑改动需要你重点看` : null;
				store.updateTask(t.id, { last_report: text, reason: warn });
				store.addEvent(t.id, attemptId, 'info', 'gates-ok', `${adapter.name} 验收通过，已提交 ${sha?.slice(0, 8) ?? '（无改动）'}`);
				if (warn) store.addEvent(t.id, attemptId, 'warn', 'suspicious', report.warnings.join('\n'));
				if (this.wantsReview(t, adapter.name)) {
					store.updateTask(t.id, { status: 'reviewing' });
					store.addEvent(t.id, attemptId, 'info', 'review', '等待另一个 AI 复核');
					this.log(`#${t.id} 验收通过（${adapter.name}），等待复核`);
					return;
				}
				return this.finishPassed(store.getTask(t.id)!, warn);
			}
			return roundFailed(text);
		} catch (e) {
			return fail(`调度器内部错误：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 跑项目的准备命令；失败返回给人看的原因（算环境问题，不扣 AI 的轮数），成功返回 null
	async prepare(t: Task, project: ProjectConfig, dir: string): Promise<string | null> {
		const { cfg, store } = this.opts;
		if (!project.setup?.length) return null;
		// 成功标记放在这个副本自己的 git 目录里（不在工作区文件里，不会被当成改动）
		const marker = path.join((await git(cfg.git, dir, ['rev-parse', '--absolute-git-dir'])).trim(), 'dispatcher-setup-ok');
		if (fs.existsSync(marker)) return null;
		const started = Date.now();
		const results = await runCommands(project.setup, dir, { cargoTarget: workPaths(cfg).cargoTarget, stopOnFail: true });
		const report = formatReport({ ok: false, changed: [], lines: 0, results, warnings: [] });
		const secs = Math.round((Date.now() - started) / 1000);
		if (results.every((r) => r.ok)) {
			fs.writeFileSync(marker, new Date().toISOString());
			store.addEvent(t.id, null, 'info', 'setup', `准备命令完成（${secs} 秒）`);
			return null;
		}
		store.addEvent(t.id, null, 'error', 'setup', `准备命令失败：\n${tail(report, 3000)}`);
		return `准备命令失败（项目环境问题，不算 AI 的轮数），请看事件里的输出，处理后点重试`;
	}

	// 这一刻能不能马上用这家：没被额度挡住、DSH 没超预算
	usable(agent: string): boolean {
		return !this.unavailable(agent) && !this.overBudget(agent);
	}

	hasSlot(agent: string): boolean {
		return this.activeCount(agent) < agentLimits(this.opts.cfg, agent).concurrency;
	}

	// 最终进入“待你验收”；子任务开了自动合并就接着合并
	async finishPassed(t: Task, warn: string | null, opts: { noAutoMerge?: boolean } = {}): Promise<void> {
		const { cfg, store } = this.opts;
		store.updateTask(t.id, { status: 'passed', reason: warn });
		store.addEvent(t.id, null, 'info', 'passed', `等待你验收${warn ? `（${warn}）` : ''}`);
		this.log(`#${t.id} 等待你验收${warn ? `：${warn}` : ''}`);
		if (t.auto_merge && !opts.noAutoMerge) {
			// 同样先在副本里合并复检，失败就留在“待你验收”并写明原因
			const m = await mergeTask(cfg, store, t.id).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
			this.log(`#${t.id} 自动合并：${m.message}`);
		}
	}

	// 判断难度、复核共用：开一轮、记用量，返回结果
	async runAux(t: Task, adapter: Adapter, worktree: string, prompt: string, label: string, signal: AbortSignal): Promise<{ r: AgentRunResult; attemptId: number }> {
		const { cfg, store } = this.opts;
		const wp = workPaths(cfg);
		const project = cfg.projects[t.project];
		fs.mkdirSync(wp.logs, { recursive: true });
		const logFile = path.join(wp.logs, `task-${t.id}-${label}-${adapter.name}-${timestampSlug()}.ndjson`);
		const paid = this.opts.paidMode?.(adapter.name) ?? false;
		const attemptId = store.addAttempt(t.id, t.attempts + 1, adapter.name, logFile, paid);
		const home = t.dsh_home ?? path.join(wp.dshHome, `task-${t.id}`);
		const r = await adapter.run({
			taskId: t.id,
			worktree,
			prompt,
			sessionId: null,
			home,
			logFile,
			timeoutMs: Math.min(agentLimits(cfg, adapter.name).timeoutMinutes, 20) * 60_000,
			audit: { worktree, sensitive: sensitiveDirs(cfg), allowedRead: [home, ...(this.opts.allowedRead ?? [])] },
			allowCommands: project ? [...project.gates.map((g) => g.cmd), project.selfCheck ?? ''].filter(Boolean) : [],
			paid,
			subagents: 0,
			signal,
			onAudit: (v, tool) => store.addEvent(t.id, attemptId, v.level === 'warn' ? 'warn' : 'error', `audit:${v.level}`, `${tool}：${v.reason}`),
		});
		store.finishAttempt(attemptId, {
			outcome: r.outcome,
			errorCode: r.errorCode,
			tokensIn: r.usage.tokensIn,
			tokensOut: r.usage.tokensOut,
			tokensCacheRead: r.usage.tokensCacheRead,
			tokensCacheWrite: r.usage.tokensCacheWrite,
			costUsd: r.costUsd ?? null,
			finalText: r.finalText,
		});
		if (r.quota) store.setAgentQuota(adapter.name, r.quota);
		if (r.paid) store.setAgentPaid(adapter.name, r.paid);
		return { r, attemptId };
	}

	// 额度用完：暂停这家，任务留在原状态，下一轮换别家
	pauseForQuota(agent: string, r: AgentRunResult): void {
		const minutes = (this.opts.cfg.agents as Record<string, { quotaPauseMinutes?: number } | undefined>)[agent]?.quotaPauseMinutes ?? DEFAULT_QUOTA_PAUSE_MINUTES;
		const until = r.resetAt && r.resetAt > new Date().toISOString() ? r.resetAt : new Date(Date.now() + minutes * 60_000).toISOString();
		this.opts.store.pauseAgent(agent, until, r.errorMessage ?? '额度用完');
		this.opts.store.addEvent(null, null, 'warn', 'quota', `${agent} 额度用完，暂停到 ${new Date(until).toLocaleString()}`);
	}

	launch(t: Task, agent: string, job: (signal: AbortSignal) => Promise<void>): void {
		const abort = new AbortController();
		const done = job(abort.signal)
			.catch((e: unknown) => {
				this.opts.store.updateTask(t.id, { status: 'needs_human', reason: `调度器内部错误：${e instanceof Error ? e.message : String(e)}` });
			})
			.finally(() => this.active.delete(t.id));
		this.active.set(t.id, { agent, abort, done });
	}

	// ---------- 判断难度 ----------
	// 判断者：设置里选的那家 → 另一家 → DSH（允许时）。挑第一家没被额度挡住的；它正忙就等它
	pickJudge(): string | null {
		const tr = triageOf(this.opts.cfg);
		const order = [tr.agent, tr.agent === 'codex' ? 'claude' : 'codex', ...(tr.dshFallback ? ['dsh'] : [])];
		const a = order.find((x) => this.opts.adapters[x] && this.usable(x));
		return a && this.hasSlot(a) ? a : null;
	}

	startTriage(): void {
		const { store } = this.opts;
		for (;;) {
			if (!store.queuedFor('auto').length) return;
			const judge = this.pickJudge();
			if (!judge) return;
			const t = store.claimNextQueued('auto');
			if (!t) return;
			this.launch(t, judge, (signal) => this.triage(t, judge, signal));
		}
	}

	// 默认给谁：升级顺序里第一家能用的
	defaultAgent(): string {
		const chain = (this.opts.cfg.escalation ?? DEFAULT_ESCALATION).filter((a) => this.opts.adapters[a]);
		return chain[0] ?? 'dsh';
	}

	async triage(t: Task, judge: string, signal: AbortSignal): Promise<void> {
		const { cfg, store } = this.opts;
		const project = cfg.projects[t.project];
		const assign = (agent: string, reason: string, triage: object | null) => {
			store.updateTask(t.id, { agent, status: 'queued', max_attempts: agentLimits(cfg, agent).maxAttempts, reason, triage: triage ? JSON.stringify(triage) : null });
			store.addEvent(t.id, null, 'info', 'triage', reason);
			this.log(`#${t.id} ${reason}`);
		};
		if (!project) return assign(this.defaultAgent(), `未知项目 ${t.project}`, null);
		const dir = path.join(workPaths(cfg).worktrees, `_triage-${t.id}-${timestampSlug()}`);
		await git(cfg.git, project.repo, ['worktree', 'add', '--detach', dir, project.baseBranch]);
		try {
			const agents = Object.keys(this.opts.adapters);
			const { r } = await this.runAux(t, this.opts.adapters[judge], dir, triagePrompt(t, agents), 'triage', signal);
			if (r.outcome === 'cancelled' || store.getTask(t.id)?.status === 'cancelled') return;
			if (r.outcome === 'error' && r.errorCode === 'QUOTA_EXHAUSTED') {
				// 不是任务的错：放回去，下一轮换别家判断
				this.pauseForQuota(judge, r);
				store.updateTask(t.id, { status: 'queued', reason: `${judge} 额度用完，换别家判断难度` });
				return;
			}
			const fallback = (why: string) => assign(this.defaultAgent(), `难度判断没成功（${why}），按默认交给 ${this.defaultAgent()}`, null);
			if (r.outcome !== 'completed') return fallback(`${judge} ${r.outcome} ${r.errorCode ?? ''} ${r.errorMessage ?? ''}`.trim().slice(0, 200));
			let v: { agent?: unknown; difficulty?: unknown; reason?: unknown };
			try {
				v = extractJson(r.finalText, '判断结果') as typeof v;
			} catch (e) {
				return fallback(e instanceof Error ? e.message : String(e));
			}
			const agent = String(v?.agent ?? '');
			if (!agents.includes(agent)) return fallback(`给出的“${agent}”不可用`);
			const difficulty = String(v.difficulty ?? '').slice(0, 10) || '未说明';
			const reason = String(v.reason ?? '').trim().slice(0, 300);
			assign(agent, `${judge} 判断：${difficulty}，交给 ${agent}${reason ? `。${reason}` : ''}`, { by: judge, agent, difficulty, reason });
		} finally {
			await removeWorktree(cfg.git, project.repo, dir).catch(() => {});
		}
	}

	// ---------- 复核 ----------
	reviewers(worker: string): string[] {
		const rv = reviewOf(this.opts.cfg);
		const order = [rv.agent, ...(rv.fallback ? [rv.agent === 'claude' ? 'codex' : 'claude'] : [])];
		// 不让一家复核自己做的
		return order.filter((a) => a !== worker && this.opts.adapters[a]);
	}

	wantsReview(t: Task, worker: string): boolean {
		const rv = reviewOf(this.opts.cfg);
		if (!rv.enabled || t.kind === 'plan') return false;
		if (rv.scope === 'dsh' && worker !== 'dsh') return false;
		return this.reviewers(worker).length > 0;
	}

	startReviews(): void {
		const { store } = this.opts;
		for (const t of store.withStatus('reviewing')) {
			if (this.active.has(t.id)) continue;
			const list = this.reviewers(t.agent);
			const reviewer = list.find((a) => this.usable(a));
			if (!reviewer) {
				// 都没额度或不可用：不等，直接交给你并写明
				this.launch(t, 'none', () => this.finishPassed(t, joinWarn(t.reason, `没有复核：${list.join('、') || '复核的 AI'} 当前没有额度或不可用`)));
				continue;
			}
			if (!this.hasSlot(reviewer)) continue;
			this.launch(t, reviewer, (signal) => this.review(t, reviewer, signal));
		}
	}

	async review(t: Task, reviewer: string, signal: AbortSignal): Promise<void> {
		const { cfg, store } = this.opts;
		const project = cfg.projects[t.project];
		if (!project || !t.worktree || !fs.existsSync(t.worktree) || !t.base_sha) return this.finishPassed(t, joinWarn(t.reason, '没有复核：工作区不在了'));
		const protectedGlobs = [...DEFAULT_PROTECTED, ...(project.protected ?? [])];
		const diff = await git(cfg.git, t.worktree, ['diff', '--no-color', t.base_sha, 'HEAD']).catch(() => '');
		const prompt = reviewPrompt(t, project, protectedGlobs, { worker: t.agent, diff, gateReport: t.last_report, workerReport: lastReport(store, t.id, t.agent) });
		const { r, attemptId } = await this.runAux(t, this.opts.adapters[reviewer], t.worktree, prompt, 'review', signal);
		if (r.outcome === 'cancelled' || store.getTask(t.id)?.status === 'cancelled') return;
		// 复核只读：万一动了文件，丢掉这些改动，保持验收通过时的样子
		if (await changedSince(cfg.git, t.worktree, 'HEAD')) {
			await git(cfg.git, t.worktree, ['reset', '--hard', 'HEAD']);
			await git(cfg.git, t.worktree, ['clean', '-fd']);
			store.addEvent(t.id, attemptId, 'warn', 'review', `${reviewer} 复核时改动了文件，已丢弃这些改动`);
		}
		if (r.outcome === 'error' && r.errorCode === 'QUOTA_EXHAUSTED') {
			// 留在“复核中”，下一轮换另一家或直接交给你
			return this.pauseForQuota(reviewer, r);
		}
		if (r.outcome === 'killed') return this.finishPassed(t, joinWarn(t.reason, `复核被审计终止（${reviewer}），请你自己仔细看`), { noAutoMerge: true });
		if (r.outcome !== 'completed') return this.finishPassed(t, joinWarn(t.reason, `复核没能完成（${reviewer} ${r.errorCode ?? r.outcome}），直接交给你`));
		let v: { verdict?: unknown; summary?: unknown; issues?: unknown };
		try {
			v = extractJson(r.finalText, '复核结果') as typeof v;
		} catch (e) {
			return this.finishPassed(t, joinWarn(t.reason, `复核结果读不出来（${e instanceof Error ? e.message : String(e)}），直接交给你`));
		}
		const issues = (Array.isArray(v.issues) ? v.issues : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
		const verdict = v.verdict === 'changes' && issues.length ? 'changes' : 'approve';
		const summary = String(v.summary ?? '').trim().slice(0, 500);
		store.updateTask(t.id, { review: JSON.stringify({ by: reviewer, verdict, summary, issues, at: new Date().toISOString() }) });
		if (verdict === 'approve') {
			store.addEvent(t.id, attemptId, 'info', 'review', `${reviewer} 复核通过${summary ? `：${summary}` : ''}`);
			return this.finishPassed(t, t.reason);
		}
		const rv = reviewOf(cfg);
		store.addEvent(t.id, attemptId, 'warn', 'review', `${reviewer} 复核发现 ${issues.length} 个问题：\n${issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
		if (t.review_rounds < rv.maxFixRounds) {
			// 交回原来做的 AI 接着改；它这一轮必须真的改了东西
			store.updateTask(t.id, {
				status: 'queued',
				feedback: `${summary ? `${summary}\n` : ''}${issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}`,
				feedback_by: reviewer,
				review_rounds: t.review_rounds + 1,
				stage_attempts: 0,
				reason: `${reviewer} 复核发现 ${issues.length} 个问题，交回 ${t.agent} 修改`,
			});
			this.log(`#${t.id} 复核发现问题，交回 ${t.agent} 修改`);
			return;
		}
		// 返工次数用完：交给你判断，不自动合并
		return this.finishPassed(t, joinWarn(t.reason, `${reviewer} 复核认为还有 ${issues.length} 个问题，请重点看`), { noAutoMerge: true });
	}

	async dependencyInfo(t: Task, repo: string): Promise<DependencyInfo[]> {
		const { cfg, store } = this.opts;
		const out: DependencyInfo[] = [];
		for (const id of t.depends_on) {
			const d = store.getTask(id);
			if (!d) continue;
			let files: string[] = [];
			if (d.merge_sha) {
				// 合并提交和它的第一个父提交相比，就是这一项带进项目的改动
				files = (await git(cfg.git, repo, ['diff', '--name-only', `${d.merge_sha}^1`, d.merge_sha]).catch(() => '')).split('\n').filter(Boolean);
			}
			out.push({ id: d.id, title: d.title, files, report: lastReport(store, d.id) });
		}
		return out;
	}

	// 拆分任务的一轮结束：取出方案交给人批准；方案不能用就和验收没通过一样重试
	async finishPlan(t: Task, repo: string, attemptId: number, finalText: string, roundFailed: (text: string) => Promise<void>): Promise<void> {
		const { cfg, store } = this.opts;
		let plan;
		try {
			plan = normalizePlan(extractPlan(finalText), enabledAgents(cfg));
		} catch (e) {
			return roundFailed(`✘ 没有得到可用的拆分方案：${e instanceof Error ? e.message : String(e)}`);
		}
		if (await changedSince(cfg.git, t.worktree!, t.base_sha!)) {
			store.addEvent(t.id, attemptId, 'warn', 'plan', '拆分时 AI 改动了文件，这些改动不会被采用');
		}
		await removeWorktree(cfg.git, repo, t.worktree!);
		store.updateTask(t.id, { status: 'planned', plan_json: JSON.stringify(plan), worktree: null, feedback: null, last_report: null, reason: null });
		store.addEvent(t.id, attemptId, 'info', 'planned', `拆分方案共 ${plan.items.length} 项，等你批准`);
		this.log(`#${t.id} 拆分方案共 ${plan.items.length} 项，等你批准`);
	}
}
