import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { acceptTask, addTask, archiveTasks, cancelTask, createDemo, rejectTask, retryTask, runChecks, saveProject } from './actions.ts';
import type { AgentName, Config } from './config.ts';
import { CODE_ROOT, DEFAULT_CLAUDE_KEY_FILE, DEFAULT_ESCALATION, DEFAULT_PAID_USD_PER_DAY, DEFAULT_PAID_USD_PER_RUN, DEFAULT_PROTECTED, appearanceOf, notifyOf, reviewOf, saveConfig, triageOf } from './config.ts';
import type { Store } from './db.ts';
import { mergeTask, redoOnLatest, undoMerge } from './merge.ts';
import { approvePlan } from './plan.ts';
import { exportPatch, exportPlan, pushToUpstream } from './export.ts';
import { AppearanceError, applyAppearance, backgroundPath, backgroundType, removeBackground, saveBackground } from './appearance.ts';
import { allModels, CLAUDE_EFFORTS, refreshDshModels } from './models.ts';
import { DEFAULT_GUARD, DEFAULT_PAID_DAILY_RUNS, dispatchState, quotaFor } from './quota.ts';
import type { Runner } from './runner.ts';

export type AppContext = {
	cfg: Config;
	store: Store;
	token: string;
	runner?: Runner;
	// 设置改动后重新组装代理（启用/停用 Claude、Codex 等）
	reloadAgents?: () => { available: string[]; skipped: string[] };
	agentStatus?: () => { available: string[]; skipped: string[] };
	// 重新读取订阅额度（Claude 走 /usage，不花额度），返回给面板显示的结果说明
	refreshQuota?: () => Promise<string>;
	shutdown?: () => void;
	startedAt: string;
};

const UI_DIR = path.join(CODE_ROOT, 'ui');
const STATIC: Record<string, string> = {
	'/app.js': 'text/javascript; charset=utf-8',
	'/style.css': 'text/css; charset=utf-8',
	'/favicon.ico': 'image/x-icon',
	// 帮助页内容（纯说明文字，不含任何数据）
	'/help.html': 'text/html; charset=utf-8',
};
const AGENTS: AgentName[] = ['dsh', 'claude', 'codex'];

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, max = 1_000_000): Promise<any> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > max) {
				reject(new HttpError(413, '请求太大'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new HttpError(400, '请求内容不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

const int = (v: unknown, min: number, max: number, name: string): number => {
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} 必须是 ${min}～${max} 之间的整数`);
	return n;
};

// 只允许改这些字段，并逐项校验；模型名会作为命令行参数传给 CLI，所以限制字符
export function applySettings(cfg: Config, body: any): void {
	const a = body?.agents ?? {};
	// 模型名会作为命令行参数或配置值传给代理；方括号用于 Claude 的 1M 上下文写法（如 claude-fable-5-1[1m]）
	const modelOf = (v: unknown, name: string) => {
		const m = String(v ?? '').trim();
		if (m && !/^[\w.:-]{1,60}(\[\w{1,8}\])?$/.test(m)) throw new HttpError(400, `${name} 模型名只能包含字母、数字和 . : _ -`);
		return m || undefined;
	};
	if (a.dsh) {
		cfg.agents.dsh.concurrency = int(a.dsh.concurrency, 1, 8, 'DSH 同时运行数');
		cfg.agents.dsh.maxAttempts = int(a.dsh.maxAttempts, 1, 5, 'DSH 最多轮数');
		cfg.agents.dsh.timeoutMinutes = int(a.dsh.timeoutMinutes, 1, 240, 'DSH 超时');
		cfg.agents.dsh.dailyTokenBudget = int(a.dsh.dailyTokenBudget, 0, 1_000_000_000, 'DSH 每日 token 预算');
		cfg.agents.dsh.model = modelOf(a.dsh.model, 'DSH');
	}
	for (const name of ['claude', 'codex'] as const) {
		const v = a[name];
		if (!v) continue;
		const cur = cfg.agents[name] ?? { enabled: false, concurrency: 1, maxAttempts: 1, timeoutMinutes: 30 };
		const model = modelOf(v.model, name) ?? '';
		const effort = String(v.effort ?? '').trim();
		const efforts = name === 'claude' ? CLAUDE_EFFORTS : [...CLAUDE_EFFORTS, 'minimal', 'ultra'];
		if (effort && !efforts.includes(effort)) throw new HttpError(400, `${name} 思考强度无效`);
		cfg.agents[name] = {
			...cur,
			enabled: Boolean(v.enabled),
			concurrency: int(v.concurrency, 1, 4, `${name} 同时运行数`),
			maxAttempts: int(v.maxAttempts, 1, 5, `${name} 最多轮数`),
			timeoutMinutes: int(v.timeoutMinutes, 1, 240, `${name} 超时`),
			quotaPauseMinutes: int(v.quotaPauseMinutes ?? cur.quotaPauseMinutes ?? 30, 5, 600, `${name} 额度暂停时长`),
			model: model || undefined,
			effort: effort || undefined,
			usePaid: Boolean(v.usePaid ?? cur.usePaid),
			paidDailyMaxRuns: int(v.paidDailyMaxRuns ?? cur.paidDailyMaxRuns ?? DEFAULT_PAID_DAILY_RUNS, 1, 200, `${name} 付费模式每日上限`),
		};
		if (name === 'claude') {
			const method = String(v.paidMethod ?? cur.paidMethod ?? 'extra_usage');
			if (!['extra_usage', 'api_key'].includes(method)) throw new HttpError(400, 'Claude 付费方式无效');
			const money = (x: unknown, min: number, max: number, label: string) => {
				const n = Number(x);
				if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}必须在 ${min}～${max} 美元之间`);
				return Math.round(n * 100) / 100;
			};
			const c = cfg.agents.claude!;
			c.paidMethod = method as 'extra_usage' | 'api_key';
			c.paidMaxUsdPerRun = money(v.paidMaxUsdPerRun ?? cur.paidMaxUsdPerRun ?? DEFAULT_PAID_USD_PER_RUN, 0.1, 100, '每轮最多花费');
			c.paidDailyMaxUsd = money(v.paidDailyMaxUsd ?? cur.paidDailyMaxUsd ?? DEFAULT_PAID_USD_PER_DAY, 0.5, 10000, '每天最多花费');
		}
		if (name === 'codex') {
			const floor = Number(v.paidMinBalance ?? cur.paidMinBalance ?? 0);
			if (!Number.isFinite(floor) || floor < 0 || floor > 1_000_000_000) throw new HttpError(400, 'Codex 余额下限必须是不小于 0 的数字');
			cfg.agents.codex!.paidMinBalance = floor;
		}
	}
	if (body?.takeover !== undefined) cfg.takeover = Boolean(body.takeover);
	if (body?.triage) {
		const agent = String(body.triage.agent);
		if (!['codex', 'claude'].includes(agent)) throw new HttpError(400, '判断难度只能选 Codex 或 Claude');
		cfg.triage = { agent: agent as 'codex' | 'claude', dshFallback: Boolean(body.triage.dshFallback) };
	}
	if (body?.review) {
		const agent = String(body.review.agent);
		const scope = String(body.review.scope);
		if (!['codex', 'claude'].includes(agent)) throw new HttpError(400, '复核只能选 Codex 或 Claude');
		if (!['dsh', 'all'].includes(scope)) throw new HttpError(400, '复核范围无效');
		cfg.review = { enabled: Boolean(body.review.enabled), agent: agent as 'codex' | 'claude', fallback: Boolean(body.review.fallback), scope: scope as 'dsh' | 'all', maxFixRounds: int(body.review.maxFixRounds, 0, 3, '复核返工次数') };
	}
	if (body?.notify) {
		const n = body.notify;
		cfg.notify = { passed: Boolean(n.passed), needsHuman: Boolean(n.needsHuman), planned: Boolean(n.planned), done: Boolean(n.done), agentDown: Boolean(n.agentDown) };
	}
	if (body?.escalation) {
		const chain = (body.escalation as unknown[]).map(String);
		if (!chain.length || chain.some((x) => !AGENTS.includes(x as AgentName)) || new Set(chain).size !== chain.length) {
			throw new HttpError(400, '升级顺序只能包含 dsh / claude / codex，且不能重复');
		}
		cfg.escalation = chain as AgentName[];
	}
	if (body?.quotaGuard) {
		cfg.quotaGuard = {
			fiveHourReservePercent: int(body.quotaGuard.fiveHourReservePercent, 0, 90, '5 小时窗口保留比例'),
			weeklyReservePercent: int(body.quotaGuard.weeklyReservePercent, 0, 90, '每周窗口保留比例'),
		};
	}
}

export function publicConfig(cfg: Config) {
	const pick = (name: 'claude' | 'codex') => {
		const v = cfg.agents[name];
		return {
			enabled: v?.enabled ?? false,
			concurrency: v?.concurrency ?? 1,
			maxAttempts: v?.maxAttempts ?? 1,
			timeoutMinutes: v?.timeoutMinutes ?? 30,
			quotaPauseMinutes: v?.quotaPauseMinutes ?? 30,
			model: v?.model ?? '',
			effort: v?.effort ?? '',
			usePaid: Boolean(v?.usePaid),
			paidDailyMaxRuns: v?.paidDailyMaxRuns ?? DEFAULT_PAID_DAILY_RUNS,
			paidMinBalance: v?.paidMinBalance ?? 0,
			paidMethod: v?.paidMethod ?? 'extra_usage',
			paidMaxUsdPerRun: v?.paidMaxUsdPerRun ?? DEFAULT_PAID_USD_PER_RUN,
			paidDailyMaxUsd: v?.paidDailyMaxUsd ?? DEFAULT_PAID_USD_PER_DAY,
			// 只告诉面板 key 文件在不在，不读内容
			keyFile: path.join(cfg.workRoot, v?.apiKeyFile ?? DEFAULT_CLAUDE_KEY_FILE),
			keyPresent: fs.existsSync(path.join(cfg.workRoot, v?.apiKeyFile ?? DEFAULT_CLAUDE_KEY_FILE)),
		};
	};
	const d = cfg.agents.dsh;
	return {
		workRoot: cfg.workRoot,
		agents: {
			dsh: { concurrency: d.concurrency, maxAttempts: d.maxAttempts, timeoutMinutes: d.timeoutMinutes, dailyTokenBudget: d.dailyTokenBudget, model: d.model ?? '' },
			claude: pick('claude'),
			codex: pick('codex'),
		},
		escalation: cfg.escalation ?? DEFAULT_ESCALATION,
		takeover: cfg.takeover !== false,
		triage: triageOf(cfg),
		review: reviewOf(cfg),
		notify: notifyOf(cfg),
		quotaGuard: { ...DEFAULT_GUARD, ...(cfg.quotaGuard ?? {}) },
		defaultProtected: DEFAULT_PROTECTED,
		projects: Object.entries(cfg.projects).map(([name, p]) => ({
			name,
			repo: p.repo,
			baseBranch: p.baseBranch,
			gates: p.gates,
			setup: p.setup ?? [],
			upstream: p.upstream ?? null,
			selfCheck: p.selfCheck ?? '',
			protected: p.protected ?? [],
		})),
	};
}

function state(ctx: AppContext) {
	const { cfg, store } = ctx;
	const status = ctx.agentStatus?.() ?? { available: [], skipped: [] };
	const running = new Set(ctx.runner ? [...ctx.runner.active.keys()] : []);
	return {
		now: new Date().toISOString(),
		startedAt: ctx.startedAt,
		runnerActive: Boolean(ctx.runner),
		guard: { ...DEFAULT_GUARD, ...(cfg.quotaGuard ?? {}) },
		tasks: store.listTasks(300).map(({ spec, last_report, ...t }) => ({ ...t, live: running.has(t.id) })),
		events: store.recentEvents(100),
		projects: Object.keys(cfg.projects),
		// 哪些项目设了同步目标（面板据此显示“推送到你的仓库”）
		upstreams: Object.fromEntries(Object.entries(cfg.projects).map(([n, p]) => [n, p.upstream ? `${p.upstream.repo}（${p.upstream.branch}）` : null])),
		takeover: cfg.takeover !== false,
		triage: triageOf(cfg),
		review: reviewOf(cfg),
		notify: notifyOf(cfg),
		appearance: { ...appearanceOf(cfg), hasBackground: Boolean(backgroundPath(cfg)) },
		agents: AGENTS.map((name) => {
			const quota = quotaFor(name, store);
			const enabled = name === 'dsh' || Boolean(cfg.agents[name]?.enabled);
			const d = dispatchState(cfg, store, name);
			const ac = name === 'dsh' ? null : cfg.agents[name];
			return {
				name,
				enabled,
				available: status.available.includes(name),
				skipped: status.skipped.find((s) => s.startsWith(name)) ?? null,
				usage: store.usageToday(name),
				budget: name === 'dsh' ? cfg.agents.dsh.dailyTokenBudget : null,
				pause: store.agentPause(name),
				quota,
				block: d.block,
				paidMode: d.paidMode,
				paid: ac
					? {
							enabled: Boolean(ac.usePaid),
							runsToday: d.paidRunsToday,
							cap: ac.paidDailyMaxRuns ?? DEFAULT_PAID_DAILY_RUNS,
							method: name === 'claude' ? (ac.paidMethod ?? 'extra_usage') : 'credits',
							costToday: store.paidCostToday(name),
							dailyUsd: ac.paidDailyMaxUsd ?? DEFAULT_PAID_USD_PER_DAY,
						}
					: null,
				running: ctx.runner ? ctx.runner.activeCount(name) : 0,
			};
		}),
	};
}

function allowedHost(req: http.IncomingMessage, port: number): boolean {
	const host = String(req.headers.host ?? '').toLowerCase();
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function sameOrigin(req: http.IncomingMessage, port: number): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export async function handle(ctx: AppContext, req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const p = url.pathname;
	// 防 DNS 重绑定：只认本机地址访问
	if (!allowedHost(req, port)) return send(res, 403, { error: '只允许本机访问' });

	if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
		const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8').replace('__DISPATCHER_TOKEN__', ctx.token);
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
		return;
	}
	if (req.method === 'GET' && STATIC[p]) {
		const file = path.join(UI_DIR, p.slice(1));
		if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
		res.writeHead(200, { 'content-type': STATIC[p], 'cache-control': 'no-store' }).end(fs.readFileSync(file));
		return;
	}
	// 背景图：CSS 里引用，带不了口令；只认本机地址（上面已检查），并禁止别的网站嵌入
	if (req.method === 'GET' && p === '/background') {
		const file = backgroundPath(ctx.cfg);
		if (!file) return send(res, 404, { error: '没有设置背景图' });
		res.writeHead(200, { 'content-type': backgroundType(file), 'cache-control': 'no-cache', 'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff' }).end(fs.readFileSync(file));
		return;
	}
	// 用于单实例检测，不含任何数据
	if (p === '/api/ping') return send(res, 200, { app: 'ai-dispatcher', pid: process.pid });

	if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
	// 面板页面里注入了本次启动的随机口令；别的网页拿不到它，也就不能冒充你操作
	if (req.headers['x-dispatcher-token'] !== ctx.token) return send(res, 401, { error: '口令无效，请从调度器窗口操作' });
	if (req.method === 'POST') {
		if (!sameOrigin(req, port)) return send(res, 403, { error: '来源不被允许' });
		if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: '需要 JSON 请求' });
	}

	const { cfg, store } = ctx;
	try {
		if (req.method === 'GET' && p === '/api/state') return send(res, 200, state(ctx));
		if (req.method === 'GET' && p === '/api/config') return send(res, 200, { ...publicConfig(cfg), status: ctx.agentStatus?.() ?? null });
		if (req.method === 'GET' && p === '/api/models') return send(res, 200, allModels(cfg));
		const tm = p.match(/^\/api\/task\/(\d+)$/);
		if (req.method === 'GET' && tm) {
			const id = Number(tm[1]);
			const task = store.getTask(id);
			if (!task) return send(res, 404, { error: `找不到任务 #${id}` });
			return send(res, 200, { task, attempts: store.attemptsFor(id), events: store.recentEvents(200, id), children: store.childrenOf(id) });
		}
		if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

		// 背景图按 base64 传，放宽到约 21MB（对应 15MB 的图片）
		const body = await readBody(req, p === '/api/appearance/background' ? 21_000_000 : 1_000_000);
		if (p.startsWith('/api/appearance')) {
			try {
				if (p === '/api/appearance') applyAppearance(cfg, body);
				else if (p === '/api/appearance/background') saveBackground(cfg, String(body.data ?? ''));
				else if (p === '/api/appearance/background/remove') removeBackground(cfg);
				else return send(res, 404, { error: 'not found' });
			} catch (e) {
				if (e instanceof AppearanceError) throw new HttpError(400, e.message);
				throw e;
			}
			return send(res, 200, { message: '外观已保存', appearance: appearanceOf(cfg) });
		}
		if (p === '/api/tasks') {
			const id = addTask(cfg, store, {
				project: String(body.project ?? ''),
				title: String(body.title ?? ''),
				spec: String(body.spec ?? ''),
				allow: Array.isArray(body.allow) ? body.allow.map(String) : [],
				readonly: Array.isArray(body.readonly) ? body.readonly.map(String) : [],
				agent: body.agent ? String(body.agent) : undefined,
				maxAttempts: body.maxAttempts ? Number(body.maxAttempts) : undefined,
				subagentLimits: body.subagents && typeof body.subagents === 'object' ? Object.fromEntries(Object.entries(body.subagents).map(([k, v]) => [String(k), Number(v)])) : {},
				split: body.split && typeof body.split === 'object' ? { childAgent: body.split.childAgent ? String(body.split.childAgent) : undefined, autoMerge: body.split.autoMerge === true } : undefined,
			});
			ctx.runner?.tick();
			return send(res, 200, { id, message: `已加入队列：#${id}` });
		}
		if (p === '/api/tasks/archive') {
			const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : undefined;
			const statuses = Array.isArray(body.statuses) ? body.statuses.map(String) : undefined;
			return send(res, 200, { message: archiveTasks(store, { ids, statuses }) });
		}
		const pm = p.match(/^\/api\/task\/(\d+)\/(approve_plan|replan)$/);
		if (pm) {
			const id = Number(pm[1]);
			let msg: string;
			if (pm[2] === 'approve_plan') msg = approvePlan(cfg, store, id, body.plan);
			else {
				const t = store.getTask(id);
				if (t?.kind !== 'plan' || t.status !== 'planned') throw new Error('只有“待批准拆分”的任务可以重新拆分');
				// 意见和上一版方案一起交给 AI
				store.updateTask(id, { feedback: String(body.reason ?? '').trim() || '请换一种拆法' });
				msg = await retryTask(cfg, store, id, { fresh: true, agent: body.agent ? String(body.agent) : undefined });
			}
			ctx.runner?.tick();
			return send(res, 200, { message: msg });
		}
		const em = p.match(/^\/api\/task\/(\d+)\/(export|export_plan|push)$/);
		if (em) {
			const id = Number(em[1]);
			if (em[2] === 'export') return send(res, 200, { message: (await exportPatch(cfg, store, id)).message });
			if (em[2] === 'export_plan') return send(res, 200, { message: (await exportPlan(cfg, store, id)).message });
			const r = await pushToUpstream(cfg, store, id);
			return send(res, r.ok ? 200 : 409, r.ok ? { message: r.message } : { error: r.message, conflicts: r.conflicts });
		}
		const mm = p.match(/^\/api\/task\/(\d+)\/(merge|unmerge|redo_latest)$/);
		if (mm) {
			const id = Number(mm[1]);
			if (mm[2] === 'redo_latest') {
				const t = store.getTask(id);
				if (!t) return send(res, 404, { error: `找不到任务 #${id}` });
				// 冲突或合并后检查失败：带着原因从项目最新代码重做
				store.updateTask(id, { feedback: redoOnLatest(t) });
				const msg = await retryTask(cfg, store, id, { fresh: true, agent: body.agent ? String(body.agent) : undefined });
				ctx.runner?.tick();
				return send(res, 200, { message: msg });
			}
			const r = mm[2] === 'merge' ? await mergeTask(cfg, store, id) : await undoMerge(cfg, store, id);
			ctx.runner?.tick();
			return send(res, r.ok ? 200 : 409, r.ok ? { message: r.message } : { error: r.message, conflicts: r.conflicts });
		}
		const am = p.match(/^\/api\/task\/(\d+)\/(accept|reject|retry|cancel)$/);
		if (am) {
			const id = Number(am[1]);
			const msg =
				am[2] === 'accept'
					? await acceptTask(cfg, store, id)
					: am[2] === 'reject'
						? await rejectTask(cfg, store, id, body.reason ? String(body.reason) : undefined)
						: am[2] === 'retry'
							? await retryTask(cfg, store, id, { fresh: Boolean(body.fresh), agent: body.agent ? String(body.agent) : undefined })
							: await cancelTask(cfg, store, id);
			ctx.runner?.tick();
			return send(res, 200, { message: msg });
		}
		if (p === '/api/settings') {
			applySettings(cfg, body);
			saveConfig(cfg);
			const status = ctx.reloadAgents?.();
			return send(res, 200, { message: '设置已保存', status });
		}
		if (p === '/api/projects') {
			const msg = saveProject(cfg, {
				name: String(body.name ?? ''),
				repo: String(body.repo ?? ''),
				baseBranch: body.baseBranch ? String(body.baseBranch) : undefined,
				gates: Array.isArray(body.gates) ? body.gates.map((g: any) => ({ name: String(g.name ?? ''), cmd: String(g.cmd ?? ''), timeoutMinutes: g.timeoutMinutes ? Number(g.timeoutMinutes) : undefined })) : [],
				setup: Array.isArray(body.setup) ? body.setup.map((g: any) => ({ name: String(g.name ?? ''), cmd: String(g.cmd ?? ''), timeoutMinutes: g.timeoutMinutes ? Number(g.timeoutMinutes) : undefined })) : [],
				upstream: body.upstream ? { repo: String(body.upstream.repo ?? ''), branch: String(body.upstream.branch ?? '') } : undefined,
				selfCheck: body.selfCheck ? String(body.selfCheck) : undefined,
				protected: Array.isArray(body.protected) ? body.protected.map(String) : [],
			});
			return send(res, 200, { message: msg });
		}
		if (p === '/api/check') return send(res, 200, { items: runChecks(cfg) });
		if (p === '/api/quota/refresh') {
			// Codex 的额度每次读取都是最新的会话记录，这里只需要刷新 Claude
			const msg = ctx.refreshQuota ? await ctx.refreshQuota() : '当前模式不支持刷新';
			ctx.runner?.tick();
			return send(res, 200, { message: `${msg}；Codex 额度读取的是最新会话记录` });
		}
		if (p === '/api/models/refresh') {
			// DSH 需要联网查；查不到时保留旧列表并把原因告诉面板，其余两家直接重读本地缓存
			let error: string | undefined;
			try {
				await refreshDshModels(cfg);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			const models = allModels(cfg);
			if (error) models.dsh.error = error;
			return send(res, 200, { ...models, message: error ? `已刷新（DSH 列表获取失败：${error}）` : '模型列表已刷新' });
		}
		if (p === '/api/demo') return send(res, 200, { message: await createDemo(cfg) });
		if (p === '/api/shutdown') {
			send(res, 200, { message: '调度器正在退出' });
			setTimeout(() => ctx.shutdown?.(), 200);
			return;
		}
		return send(res, 404, { error: 'not found' });
	} catch (e) {
		const status = e instanceof HttpError ? e.status : 400;
		return send(res, status, { error: e instanceof Error ? e.message : String(e) });
	}
}

export function startServer(ctx: AppContext, port: number, host = '127.0.0.1'): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		handle(ctx, req, res, (server.address() as { port: number }).port).catch((e) => send(res, 500, { error: String(e) }));
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}
