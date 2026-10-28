import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workerEnv } from './adapters/dsh.ts';
import type { CliAgentConfig, Config } from './config.ts';
import { DEFAULT_CLAUDE_KEY_FILE, DEFAULT_PAID_USD_PER_DAY } from './config.ts';
import type { Store } from './db.ts';
import { run } from './util.ts';

// utilization 是 0~1 的已用比例；resetsAt 是 ISO 时间
export type QuotaWindow = { utilization: number; resetsAt: string };
// paid：付费额度的情况。Codex 能读到充值余额；Claude 只能读到“额外用量”是否开启
export type PaidInfo = { available: boolean; balance?: number | null; note: string };
export type AgentQuota = { windows: Record<string, QuotaWindow>; at: string; source: string; paid?: PaidInfo };

export const WINDOW_LABEL: Record<string, string> = { five_hour: '5 小时', seven_day: '每周' };

function windowName(minutes: number): string {
	if (minutes === 300) return 'five_hour';
	if (minutes === 10080) return 'seven_day';
	return `${minutes}min`;
}

// Codex 每次对话都会把额度快照写进会话记录（~/.codex/sessions/年/月/日/rollout-*.jsonl 的 rate_limits）。
// 包括你自己在 Codex App 里的使用，所以这里读到的是账号整体的额度，不只是调度器用掉的
export function parseCodexRollout(text: string, fallbackAt: string): AgentQuota | null {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes('"rate_limits"')) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		const rl = ev?.payload?.rate_limits;
		if (!rl) continue;
		const windows: Record<string, QuotaWindow> = {};
		for (const w of [rl.primary, rl.secondary]) {
			if (!w || typeof w.used_percent !== 'number' || !w.resets_at) continue;
			windows[windowName(Number(w.window_minutes))] = {
				utilization: w.used_percent / 100,
				resetsAt: new Date(Number(w.resets_at) * 1000).toISOString(),
			};
		}
		// 实测字段：credits: { has_credits, unlimited, balance: "667.0159090000" }
		const c = rl.credits;
		const balance = c?.balance !== undefined && c?.balance !== null ? Number(c.balance) : null;
		const paid: PaidInfo | undefined = c
			? {
					available: Boolean(c.unlimited) || (Boolean(c.has_credits) && (balance ?? 0) > 0),
					balance: Number.isFinite(balance) ? balance : null,
					note: c.unlimited ? '充值额度不限' : c.has_credits ? `充值余额 ${balance ?? '未知'}` : '没有充值额度',
				}
			: undefined;
		if (Object.keys(windows).length) return { windows, at: ev.timestamp ?? fallbackAt, source: 'Codex 会话记录', paid };
	}
	return null;
}

const cache = new Map<string, { mtime: number; quota: AgentQuota | null }>();

export function readCodexQuota(home = os.homedir()): AgentQuota | null {
	const root = path.join(home, '.codex', 'sessions');
	if (!fs.existsSync(root)) return null;
	// 按日期目录倒序，最多看最近 7 天里最新的几个文件
	const files: { file: string; mtime: number }[] = [];
	const desc = (dir: string) =>
		fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.filter((n) => /^\d+$/.test(n))
					.sort((a, b) => Number(b) - Number(a))
			: [];
	outer: for (const y of desc(root)) {
		for (const m of desc(path.join(root, y))) {
			for (const d of desc(path.join(root, y, m))) {
				const dir = path.join(root, y, m, d);
				for (const n of fs.readdirSync(dir)) {
					if (!n.endsWith('.jsonl')) continue;
					const file = path.join(dir, n);
					files.push({ file, mtime: fs.statSync(file).mtimeMs });
				}
				if (files.length >= 20) break outer;
			}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	for (const { file, mtime } of files.slice(0, 5)) {
		const hit = cache.get(file);
		let quota: AgentQuota | null;
		if (hit && hit.mtime === mtime) quota = hit.quota;
		else {
			quota = parseCodexRollout(fs.readFileSync(file, 'utf8'), new Date(mtime).toISOString());
			cache.set(file, { mtime, quota });
		}
		if (quota) return quota;
	}
	return null;
}

export function quotaFor(agent: string, store: Store): AgentQuota | null {
	if (agent === 'codex') return readCodexQuota();
	if (agent === 'claude') {
		const q = store.agentQuota('claude');
		return q ? { windows: q.windows, at: q.at, source: q.source ?? '最近一次 Claude 运行', paid: q.paid ?? undefined } : null;
	}
	return null;
}

export const DEFAULT_PAID_DAILY_RUNS = 10;

export type DispatchState = { block: string | null; paidMode: boolean; paidRunsToday: number; paidCostToday?: number };

// 决定这个代理现在能不能接新任务：
// - 订阅额度在保留线以上：正常派发
// - 到了保留线、但开启了付费模式：继续派发（计入付费次数），直到每日上限或余额不足
// - 其余情况：挡住，并说明原因
export function dispatchState(cfg: Config, store: Store, agent: string, now = new Date()): DispatchState {
	if (agent === 'dsh') return { block: null, paidMode: false, paidRunsToday: 0 };
	const q = quotaFor(agent, store);
	const base = quotaBlockReason(cfg, q, now);
	const a = (cfg.agents as Record<string, CliAgentConfig | undefined>)[agent];
	const used = store.paidRunsToday(agent);
	if (!base) return { block: null, paidMode: false, paidRunsToday: used };
	if (!a?.usePaid) return { block: base, paidMode: false, paidRunsToday: used };
	const cap = a.paidDailyMaxRuns ?? DEFAULT_PAID_DAILY_RUNS;
	if (used >= cap) return { block: `${base}；付费模式今天已运行 ${used} 轮，到达每日上限 ${cap}`, paidMode: false, paidRunsToday: used };
	// Claude 用 Console 的 API Key 付费：不看 claude.ai 的额外用量，看 key 是否放好、今天花了多少钱
	if (agent === 'claude' && a.paidMethod === 'api_key') {
		const keyFile = path.join(cfg.workRoot, a.apiKeyFile ?? DEFAULT_CLAUDE_KEY_FILE);
		const spent = store.paidCostToday(agent);
		const capUsd = a.paidDailyMaxUsd ?? DEFAULT_PAID_USD_PER_DAY;
		const st = { paidRunsToday: used, paidCostToday: spent };
		if (!fs.existsSync(keyFile)) return { ...st, block: `${base}；付费方式是 API Key，但没有找到 key 文件 ${keyFile}`, paidMode: false };
		if (spent >= capUsd) return { ...st, block: `${base}；今天 API 已花 $${spent.toFixed(2)}，到达每日上限 $${capUsd}`, paidMode: false };
		return { ...st, block: null, paidMode: true };
	}
	const paid = q?.paid;
	if (paid && !paid.available) return { block: `${base}；没有可用的付费额度（${paid.note}）`, paidMode: false, paidRunsToday: used };
	const floor = a.paidMinBalance ?? 0;
	if (agent === 'codex' && typeof paid?.balance === 'number' && paid.balance <= floor) {
		return { block: `${base}；充值余额 ${paid.balance} 已到你设的下限 ${floor}`, paidMode: false, paidRunsToday: used };
	}
	return { block: null, paidMode: true, paidRunsToday: used };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// “resets Oct 28, 5:19pm (Asia/Tokyo)” 或 “resets 5:19pm”。按本机时区理解（Claude 显示的就是本机时区）
export function parseResetText(text: string, now = new Date()): string | null {
	const m = text.match(/resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
	if (!m) return null;
	let hour = Number(m[3]);
	const minute = Number(m[4] ?? 0);
	const ampm = m[5]?.toLowerCase();
	if (ampm === 'pm' && hour < 12) hour += 12;
	if (ampm === 'am' && hour === 12) hour = 0;
	const d = new Date(now);
	d.setSeconds(0, 0);
	d.setHours(hour, minute);
	if (m[1]) {
		const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
		if (month < 0) return null;
		d.setMonth(month, Number(m[2]));
		// 跨年：解析出的时间比现在早一天以上，说明是明年
		if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
	} else if (d <= now) {
		d.setDate(d.getDate() + 1);
	}
	return d.toISOString();
}

// 解析 Claude Code 的 /usage 输出（实测格式）：
//   Current session: 85% used · resets Oct 28, 5:19pm (Asia/Tokyo)
//   Current week (all models): 14% used · resets Oct 28, 5:59pm (Asia/Tokyo)
export function parseClaudeUsageText(text: string, now = new Date()): Record<string, QuotaWindow> | null {
	const windows: Record<string, QuotaWindow> = {};
	for (const line of text.split('\n')) {
		const m = line.match(/^\s*Current\s+(session|week(?:\s*\(all models\))?)\s*:\s*(\d+(?:\.\d+)?)%\s*used(.*)$/i);
		if (!m) continue;
		const name = /^session/i.test(m[1]) ? 'five_hour' : 'seven_day';
		if (name === 'seven_day' && windows.seven_day) continue;
		const resetsAt = parseResetText(m[3], now);
		if (!resetsAt) continue;
		windows[name] = { utilization: Number(m[2]) / 100, resetsAt };
	}
	return Object.keys(windows).length ? windows : null;
}

// /usage 是 Claude Code 的本地命令：不调用模型、不消耗额度。--no-session-persistence 避免在你的记录里留下空会话
export async function refreshClaudeQuota(exe: string, store: Store, cwd: string): Promise<AgentQuota | null> {
	const r = await run(exe, ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--tools', ''], {
		cwd,
		env: workerEnv({}),
		input: '/usage',
		timeoutMs: 60_000,
	});
	let text = '';
	for (const line of r.stdout.split('\n')) {
		try {
			const ev = JSON.parse(line);
			if (ev.type === 'assistant') text += (ev.message?.content ?? []).map((c: any) => c?.text ?? '').join('\n');
		} catch {}
	}
	const windows = parseClaudeUsageText(text);
	if (!windows) throw new Error(`没能从 Claude 的 /usage 读到额度：${(text || r.stderr).slice(0, 200)}`);
	store.setAgentQuota('claude', windows, 'Claude /usage（不消耗额度）');
	return quotaFor('claude', store);
}

export const DEFAULT_GUARD = { fiveHourReservePercent: 15, weeklyReservePercent: 15 };

// 剩余比例（0~100 的整数），面板和保护逻辑都用它，避免两边四舍五入不一致
export function remainingPercent(w: QuotaWindow): number {
	return Math.max(0, Math.min(100, Math.round((1 - w.utilization) * 100)));
}

// 剩余额度降到为你保留的比例时不再自动派发。窗口已经重置过的旧数据不算
export function quotaBlockReason(cfg: Config, q: AgentQuota | null, now = new Date()): string | null {
	if (!q) return null;
	const guard = { ...DEFAULT_GUARD, ...(cfg.quotaGuard ?? {}) };
	for (const [name, w] of Object.entries(q.windows)) {
		if (new Date(w.resetsAt) <= now) continue;
		const reserve = name === 'five_hour' ? guard.fiveHourReservePercent : guard.weeklyReservePercent;
		const left = remainingPercent(w);
		if (left <= reserve) {
			return `${WINDOW_LABEL[name] ?? name}额度只剩 ${left}%（已到为你保留的 ${reserve}%），${new Date(w.resetsAt).toLocaleString()} 重置前不自动派发`;
		}
	}
	return null;
}
