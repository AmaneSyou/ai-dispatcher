import os from 'node:os';
import type { AuditContext, AuditVerdict } from '../audit.ts';
import { auditToolCall } from '../audit.ts';
import type { CliAgentConfig } from '../config.ts';
import { workerEnv } from './dsh.ts';
import type { JsonlRunOutput } from './jsonl.ts';
import { classifyErrorText, parseResetAt, runJsonl } from './jsonl.ts';
import { CodexSubagentWatcher } from './subagents.ts';
import type { Adapter, AgentRunInput, AgentRunResult } from './types.ts';
import { emptyResult } from './types.ts';

// 忽略用户配置是为了不加载用户的插件、MCP 服务和记忆功能；
// 但 Windows 沙盒开关也在用户配置里，必须单独补上，否则所有命令都会被拒绝（实测）
const CODEX_OVERRIDES = [
	'-c',
	'approval_policy="never"',
	'-c',
	'sandbox_mode="workspace-write"',
	'-c',
	'windows.sandbox="unelevated"',
	'-c',
	'sandbox_workspace_write.network_access=false',
	// multi_agent 默认是开着的（实测 codex-cli 0.164），子代理的动作调度器还看不到，先关掉
	'-c',
	'features.multi_agent=false',
];

export function codexArgs(cfg: CliAgentConfig, worktree: string, sessionId: string | null, allowSubagents = false): string[] {
	const model = cfg.model ? ['-m', cfg.model] : [];
	const effort = cfg.effort ? ['-c', `model_reasoning_effort="${cfg.effort}"`] : [];
	// 任务允许子代理时去掉 multi_agent=false，恢复 Codex 默认的子代理功能，由 CodexSubagentWatcher 监视
	const overrides = allowSubagents ? CODEX_OVERRIDES.filter((x, i, a) => x !== 'features.multi_agent=false' && !(x === '-c' && a[i + 1] === 'features.multi_agent=false')) : CODEX_OVERRIDES;
	if (sessionId) {
		return ['exec', 'resume', '--json', '--ignore-user-config', ...overrides, ...model, ...effort, sessionId, '-'];
	}
	return ['exec', '--json', '--ignore-user-config', ...overrides, ...model, ...effort, '-C', worktree, '-'];
}

export function createCodexParser(sessionId: string | null, audit: AuditContext, onAudit?: (v: AuditVerdict, tool: string) => void) {
	const result = emptyResult(sessionId);
	const audited = new Set<string>();
	let completed = false;
	let failed = false;

	const check = (id: string, tool: string, input: unknown): 'stop' | void => {
		if (audited.has(id)) return;
		audited.add(id);
		const v = auditToolCall(tool, input, audit);
		if (v.level === 'ok') return;
		result.violations.push(v);
		onAudit?.(v, tool);
		return v.level === 'block' || v.level === 'escalation' ? 'stop' : undefined;
	};

	return {
		result,
		onEvent(ev: Record<string, any>): 'stop' | void {
			switch (ev.type) {
				case 'thread.started':
					result.sessionId = ev.thread_id ?? result.sessionId;
					return;
				case 'item.started':
				case 'item.completed': {
					const item = ev.item ?? {};
					const id = String(item.id ?? Math.random());
					if (item.type === 'command_execution' && typeof item.command === 'string') {
						return check(`cmd:${id}`, 'shell', { command: item.command });
					}
					if (item.type === 'file_change' && Array.isArray(item.changes)) {
						const paths = item.changes.map((c: any) => c?.path).filter((p: unknown) => typeof p === 'string');
						return check(`file:${id}`, 'write', { paths });
					}
					if (item.type === 'web_search' && !audited.has(`web:${id}`)) {
						// 已关闭联网，仍出现搜索说明配置没生效，记下来给人看
						audited.add(`web:${id}`);
						const v: AuditVerdict = { level: 'warn', reason: `出现了联网搜索：${String(item.query ?? '')}` };
						result.violations.push(v);
						onAudit?.(v, 'web_search');
						return;
					}
					if (item.type === 'agent_message' && ev.type === 'item.completed') {
						result.finalText = String(item.text ?? '');
					}
					return;
				}
				case 'turn.completed': {
					completed = true;
					const u = ev.usage ?? {};
					// Codex 的 input_tokens 包含缓存命中部分，要扣掉才是按全价计的输入
					const input = Number(u.input_tokens) || 0;
					const cached = Number(u.cached_input_tokens) || 0;
					result.usage.tokensIn += Math.max(0, input - cached);
					result.usage.tokensCacheRead += cached;
					result.usage.tokensCacheWrite += Number(u.cache_write_input_tokens) || 0;
					result.usage.tokensOut += (Number(u.output_tokens) || 0) + (Number(u.reasoning_output_tokens) || 0);
					return;
				}
				case 'turn.failed': {
					failed = true;
					const msg = String(ev.error?.message ?? 'turn failed');
					result.errorCode = classifyErrorText(msg) ?? 'TURN_FAILED';
					result.errorMessage = msg;
					result.resetAt ??= parseResetAt(msg);
					return;
				}
				case 'error': {
					// 可能只是“重连中”之类的过程信息，是否失败以 turn.completed / turn.failed 为准
					const msg = String(ev.message ?? '');
					result.errorMessage = msg;
					result.resetAt ??= parseResetAt(msg);
					return;
				}
			}
		},
		finish(out: JsonlRunOutput): AgentRunResult {
			result.exitCode = out.exitCode;
			if (out.spawnError) {
				result.outcome = 'error';
				result.errorCode = 'SPAWN_FAILED';
				result.errorMessage = out.spawnError;
			} else if (out.stopReason) {
				result.outcome = out.stopReason;
			} else if (completed && !failed) {
				result.outcome = 'completed';
				result.errorMessage = null;
			} else {
				result.outcome = 'error';
				const text = `${result.errorMessage ?? ''} ${out.stderrTail}`.trim();
				result.errorCode ??= classifyErrorText(text) ?? 'NO_TURN_COMPLETED';
				result.errorMessage = text || '进程结束但没有 turn.completed 事件';
				result.resetAt ??= parseResetAt(text);
			}
			return result;
		},
	};
}

export function createCodexAdapter(cfg: CliAgentConfig, exe: string): Adapter {
	return {
		name: 'codex',
		async run(input: AgentRunInput): Promise<AgentRunResult> {
			const parser = createCodexParser(input.sessionId, input.audit, input.onAudit);
			const subN = Math.max(0, Math.floor(input.subagents ?? 0));
			const watcher =
				subN > 0
					? new CodexSubagentWatcher({
							home: os.homedir(),
							since: Date.now(),
							max: subN,
							audit: input.audit,
							mainThreadId: () => parser.result.sessionId,
							onViolation: (v, tool) => {
								parser.result.violations.push(v);
								input.onAudit?.(v, tool);
							},
						})
					: null;
			let poll: NodeJS.Timeout | null = null;
			const out = await runJsonl({
				exe,
				args: codexArgs(cfg, input.worktree, input.sessionId, subN > 0),
				cwd: input.worktree,
				env: workerEnv({}),
				stdin: input.prompt,
				logFile: input.logFile,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
				onEvent: parser.onEvent,
				onStart: (stop) => {
					if (!watcher) return;
					// 每秒读一次子代理的 rollout 文件；越界或超出数量就结束整个 Codex 进程
					poll = setInterval(() => {
						if (watcher.scan()) stop('killed');
					}, 1000);
				},
			});
			if (poll) clearInterval(poll);
			const result = parser.finish(out);
			if (watcher) {
				if (watcher.scan() && result.outcome === 'completed') result.outcome = 'killed';
				const s = watcher.summary();
				result.usage.tokensIn += s.usage.tokensIn;
				result.usage.tokensOut += s.usage.tokensOut;
				result.usage.tokensCacheRead += s.usage.tokensCacheRead;
				result.usage.tokensCacheWrite += s.usage.tokensCacheWrite;
				result.subagents = { count: s.count, lines: s.lines };
			}
			return result;
		},
	};
}
