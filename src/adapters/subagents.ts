// DSH 的子代理跑在 DSH 进程内部，它们的工具调用不会出现在 --json 事件流里（实测）。
// 但每个子代理都有自己的会话文件 DSH_HOME/sessions/<目录>/<子代理ID>/session.v4.jsonl.zstd，
// 而且是边跑边写（实测约 1 秒内可见）。这里定时读这些文件：用同样的规则审计每个工具调用，并补算 token。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AuditContext, AuditVerdict } from '../audit.ts';
import { auditToolCall } from '../audit.ts';
import type { Usage } from './types.ts';

const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
export const zstdAvailable = typeof zstd === 'function';

export type ParsedSession = {
	id: string;
	origin: string | null;
	parent: string | null;
	createdAt: number;
	calls: { callId: string; name: string; args: unknown }[];
	usage: Usage;
};

// 解析解压后的会话文本。最后一行可能还没写完，解析失败的行直接跳过
export function parseSession(text: string): ParsedSession | null {
	const recs: any[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			recs.push(JSON.parse(line));
		} catch {}
	}
	const head = recs.find((r) => r?.type === 'session');
	if (!head) return null;
	const usage: Usage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
	const calls: ParsedSession['calls'] = [];
	for (const r of recs) {
		if (r.type === 'tool/call' && r.data?.name) {
			let args: unknown = r.data.arguments;
			if (typeof args === 'string') {
				try {
					args = JSON.parse(args);
				} catch {}
			}
			calls.push({ callId: String(r.data.callId ?? calls.length), name: String(r.data.name), args });
		}
		// 实测用量只在 assistant/message.data.usage 里记一次（stream 里的分片不能重复计）
		if (r.type === 'assistant/message' && r.data?.usage) {
			const u = r.data.usage;
			usage.tokensIn += Number(u.inputTokens) || 0;
			usage.tokensOut += Number(u.outputTokens) || 0;
			usage.tokensCacheRead += Number(u.cacheReadTokens) || 0;
			usage.tokensCacheWrite += Number(u.cacheWriteTokens) || 0;
		}
	}
	return { id: String(head.id), origin: head.origin ?? null, parent: head.parentSession ?? null, createdAt: Number(head.createdAt) || 0, calls, usage };
}

export type SubagentSummary = { count: number; usage: Usage; lines: string[] };

export class SubagentWatcher {
	home: string;
	since: number;
	audit: AuditContext;
	onViolation: (v: AuditVerdict, tool: string) => void;
	mainSessionId: string | null = null;
	seenCalls = new Map<string, Set<string>>();
	sessions = new Map<string, ParsedSession>();

	constructor(opts: { home: string; since: number; audit: AuditContext; onViolation: (v: AuditVerdict, tool: string) => void }) {
		this.home = opts.home;
		this.since = opts.since;
		this.audit = opts.audit;
		this.onViolation = opts.onViolation;
	}

	files(): string[] {
		const root = path.join(this.home, 'sessions');
		if (!fs.existsSync(root)) return [];
		const out: string[] = [];
		for (const d of fs.readdirSync(root)) {
			const dir = path.join(root, d);
			if (!fs.statSync(dir).isDirectory()) continue;
			for (const s of fs.readdirSync(dir)) {
				const f = path.join(dir, s, 'session.v4.jsonl.zstd');
				// 只看这一轮开始之后写过的文件；续聊时旧子代理的记录不重复计
				if (fs.existsSync(f) && fs.statSync(f).mtimeMs >= this.since - 2000) out.push(f);
			}
		}
		return out;
	}

	// 返回需要立即终止的违规（越界、碰凭据、申请提权），没有则返回 null
	scan(): AuditVerdict | null {
		if (!zstd) return null;
		let stop: AuditVerdict | null = null;
		for (const f of this.files()) {
			let s: ParsedSession | null = null;
			try {
				s = parseSession(zstd(fs.readFileSync(f)).toString('utf8'));
			} catch {
				// 文件正在写，下次再读
				continue;
			}
			if (!s || s.origin !== 'subagent' || s.createdAt < this.since - 2000) continue;
			if (this.mainSessionId && s.parent && s.parent !== this.mainSessionId && !this.sessions.has(s.parent)) continue;
			this.sessions.set(s.id, s);
			const seen = this.seenCalls.get(s.id) ?? new Set<string>();
			this.seenCalls.set(s.id, seen);
			for (const c of s.calls) {
				if (seen.has(c.callId)) continue;
				seen.add(c.callId);
				const v = auditToolCall(c.name, c.args, this.audit);
				if (v.level === 'ok') continue;
				const tagged = { ...v, reason: `子代理 ${s.id.slice(0, 8)}：${v.reason}` };
				this.onViolation(tagged, `子代理:${c.name}`);
				if ((v.level === 'block' || v.level === 'escalation') && !stop) stop = tagged;
			}
		}
		return stop;
	}

	summary(): SubagentSummary {
		const usage: Usage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
		const lines: string[] = [];
		for (const s of this.sessions.values()) {
			usage.tokensIn += s.usage.tokensIn;
			usage.tokensOut += s.usage.tokensOut;
			usage.tokensCacheRead += s.usage.tokensCacheRead;
			usage.tokensCacheWrite += s.usage.tokensCacheWrite;
			const names = s.calls.map((c) => c.name).join('、') || '无';
			lines.push(`子代理 ${s.id.slice(0, 8)}：${s.calls.length} 次工具调用（${names}），输入 ${s.usage.tokensIn} / 输出 ${s.usage.tokensOut} token`);
		}
		return { count: this.sessions.size, usage, lines };
	}
}

// ---------- Codex ----------
// Codex 的子代理（multi_agent）同样不在 exec --json 里（只有 collab_tool_call 的 wait），
// 但每个子代理会在 ~/.codex/sessions/年/月/日/ 写自己的 rollout-*.jsonl（实测），
// session_meta.payload.source.subagent.thread_spawn.parent_thread_id 指向派它的线程。

export type CodexRollout = {
	id: string;
	parent: string | null;
	calls: { callId: string; tool: string; input: unknown }[];
	usage: Usage;
};

// apply_patch 的补丁正文里，改动的文件写在 "*** Update File: 路径" 这类行上
function patchPaths(text: string): string[] {
	return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]).trim());
}

// 把 Codex 的各种工具调用换成审计能理解的形式：命令按 shell 审，补丁按写文件审
function codexCall(name: string, raw: unknown): { tool: string; input: unknown } {
	let args: any = raw;
	if (typeof raw === 'string') {
		try {
			args = JSON.parse(raw);
		} catch {
			args = raw;
		}
	}
	if (/apply_patch/i.test(name)) return { tool: 'write', input: { paths: patchPaths(typeof args === 'string' ? args : String(args?.input ?? args?.patch ?? '')) } };
	if (typeof args === 'string') return { tool: 'shell', input: { command: args } };
	const cmd = args?.cmd ?? args?.command;
	if (cmd !== undefined) return { tool: 'shell', input: { command: Array.isArray(cmd) ? cmd.join(' ') : String(cmd), workdir: args.workdir } };
	return { tool: name, input: args };
}

export function parseCodexRolloutText(text: string): CodexRollout | null {
	let meta: any = null;
	const calls: CodexRollout['calls'] = [];
	let last: any = null;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let r: any;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		const p = r.payload ?? {};
		if (r.type === 'session_meta' && !meta) meta = p;
		if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
			const name = String(p.name ?? p.type);
			const { tool, input } = codexCall(name, p.arguments ?? p.input ?? p.action);
			calls.push({ callId: String(p.call_id ?? p.id ?? calls.length), tool, input });
		}
		if (p.type === 'token_count' && p.info?.total_token_usage) last = p.info.total_token_usage;
	}
	if (!meta?.id) return null;
	const input = Number(last?.input_tokens) || 0;
	const cached = Number(last?.cached_input_tokens) || 0;
	return {
		id: String(meta.id),
		parent: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
		calls,
		usage: {
			tokensIn: Math.max(0, input - cached),
			tokensOut: (Number(last?.output_tokens) || 0) + (Number(last?.reasoning_output_tokens) || 0),
			tokensCacheRead: cached,
			tokensCacheWrite: Number(last?.cache_write_input_tokens) || 0,
		},
	};
}

export class CodexSubagentWatcher {
	root: string;
	since: number;
	max: number;
	audit: AuditContext;
	onViolation: (v: AuditVerdict, tool: string) => void;
	mainThreadId: () => string | null;
	seenCalls = new Map<string, Set<string>>();
	rollouts = new Map<string, CodexRollout>();

	constructor(opts: { home: string; since: number; max: number; audit: AuditContext; mainThreadId: () => string | null; onViolation: (v: AuditVerdict, tool: string) => void }) {
		this.root = path.join(opts.home, '.codex', 'sessions');
		this.since = opts.since;
		this.max = opts.max;
		this.audit = opts.audit;
		this.mainThreadId = opts.mainThreadId;
		this.onViolation = opts.onViolation;
	}

	// 只看今天和昨天的目录（跨零点），以及本轮开始后写过的文件
	files(): string[] {
		const out: string[] = [];
		for (const offset of [0, 1]) {
			const d = new Date(this.since - offset * 86_400_000);
			const dir = path.join(this.root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
			if (!fs.existsSync(dir)) continue;
			for (const n of fs.readdirSync(dir)) {
				const f = path.join(dir, n);
				if (n.endsWith('.jsonl') && fs.statSync(f).mtimeMs >= this.since - 2000) out.push(f);
			}
		}
		return out;
	}

	scan(): AuditVerdict | null {
		const main = this.mainThreadId();
		if (!main) return null;
		let stop: AuditVerdict | null = null;
		const flag = (v: AuditVerdict, tool: string) => {
			this.onViolation(v, tool);
			if ((v.level === 'block' || v.level === 'escalation') && !stop) stop = v;
		};
		for (const f of this.files()) {
			let r: CodexRollout | null = null;
			try {
				r = parseCodexRolloutText(fs.readFileSync(f, 'utf8'));
			} catch {
				continue;
			}
			// 只管这一轮主线程派出的子代理（以及它们再派的）
			if (!r?.parent || (r.parent !== main && !this.rollouts.has(r.parent))) continue;
			if (!this.rollouts.has(r.id) && this.rollouts.size + 1 > this.max) {
				this.rollouts.set(r.id, r);
				flag({ level: 'block', reason: `Codex 这一轮派出的子代理超过允许的 ${this.max} 个` }, '子代理:spawn_agent');
			}
			this.rollouts.set(r.id, r);
			const seen = this.seenCalls.get(r.id) ?? new Set<string>();
			this.seenCalls.set(r.id, seen);
			for (const c of r.calls) {
				if (seen.has(c.callId)) continue;
				seen.add(c.callId);
				const v = auditToolCall(c.tool, c.input, this.audit);
				if (v.level !== 'ok') flag({ ...v, reason: `子代理 ${r.id.slice(-8)}：${v.reason}` }, `子代理:${c.tool}`);
			}
		}
		return stop;
	}

	summary(): SubagentSummary {
		const usage: Usage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
		const lines: string[] = [];
		for (const r of this.rollouts.values()) {
			usage.tokensIn += r.usage.tokensIn;
			usage.tokensOut += r.usage.tokensOut;
			usage.tokensCacheRead += r.usage.tokensCacheRead;
			usage.tokensCacheWrite += r.usage.tokensCacheWrite;
			lines.push(`子代理 ${r.id.slice(-8)}：${r.calls.length} 次工具调用，输入 ${r.usage.tokensIn}（另有缓存 ${r.usage.tokensCacheRead}）/ 输出 ${r.usage.tokensOut} token`);
		}
		return { count: this.rollouts.size, usage, lines };
	}
}
