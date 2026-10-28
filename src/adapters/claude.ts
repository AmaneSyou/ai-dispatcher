import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AuditContext, AuditVerdict } from '../audit.ts';
import { auditToolCall } from '../audit.ts';
import type { CliAgentConfig } from '../config.ts';
import { DEFAULT_PAID_USD_PER_RUN } from '../config.ts';
import { workerEnv } from './dsh.ts';
import type { JsonlRunOutput } from './jsonl.ts';
import { classifyErrorText, parseResetAt, runJsonl } from './jsonl.ts';
import type { Adapter, AgentRunInput, AgentRunResult, QuotaWindows } from './types.ts';
import { emptyResult } from './types.ts';

// 只给文件工具和命令工具；不给子代理、联网、MCP。命令工具只放行项目的验收/自查命令和只读 git
export const CLAUDE_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,PowerShell';

export function allowedToolPatterns(commands: string[]): string[] {
	const out: string[] = [];
	const add = (cmd: string) => {
		for (const tool of ['Bash', 'PowerShell']) out.push(`${tool}(${cmd})`, `${tool}(${cmd} *)`);
	};
	for (const c of commands) add(c.trim());
	for (const g of ['git status', 'git diff', 'git log', 'git show']) add(g);
	return [...new Set(out)];
}

export function claudeArgs(cfg: CliAgentConfig, sessionId: string, resume: boolean, commands: string[], subagents = 0): string[] {
	// 任务允许子代理时才放行 Agent 工具。子代理的工具调用在 stream-json 里带 parent_tool_use_id，同样会被审计（实测）
	const tools = subagents > 0 ? `${CLAUDE_TOOLS},Agent` : CLAUDE_TOOLS;
	const args = [
		'-p',
		'--output-format',
		'stream-json',
		'--verbose',
		// restricted：不读用户/项目设置，文件工具限制在工作目录内，改 git/设置文件只能由人批准
		'--restricted',
		'--strict-mcp-config',
		'--permission-mode',
		'acceptEdits',
		// 无人值守：任何需要确认的操作一律拒绝
		'--permission-prompts',
		'none',
		'--tools',
		tools,
	];
	if (cfg.model) args.push('--model', cfg.model);
	if (cfg.effort) args.push('--effort', cfg.effort);
	args.push(resume ? '--resume' : '--session-id', sessionId);
	// --allowedTools 是可变长参数，放最后，避免吞掉后面的选项
	args.push('--allowedTools', ...allowedToolPatterns(commands));
	return args;
}

export function createClaudeParser(sessionId: string, audit: AuditContext, onAudit?: (v: AuditVerdict, tool: string) => void, maxSubagents = 0) {
	const result = emptyResult(sessionId);
	let sawResult = false;
	// 实测事件：system/task_started 表示派出一个子代理，task_notification / task_updated(completed) 表示结束
	const active = new Set<string>();
	const started = new Map<string, string>();
	const block = (v: AuditVerdict, tool: string): 'stop' => {
		result.violations.push(v);
		onAudit?.(v, tool);
		return 'stop';
	};
	if (maxSubagents > 0) result.subagents = { count: 0, lines: [] };
	return {
		result,
		onEvent(ev: Record<string, any>): 'stop' | void {
			if (ev.session_id) result.sessionId = ev.session_id;
			if (ev.type === 'system' && ev.subtype === 'task_started' && ev.task_id) {
				const id = String(ev.task_id);
				active.add(id);
				started.set(id, String(ev.description ?? ''));
				if (result.subagents) result.subagents = { count: started.size, lines: [...started.values()].map((d, i) => `子代理 ${i + 1}：${d}`) };
				// 没允许却派了（理论上 Agent 工具没放行不会发生），或同时超过上限：都终止
				if (maxSubagents <= 0) return block({ level: 'block', reason: '这个任务不允许子代理，但出现了子代理' }, 'Agent');
				if (active.size > maxSubagents) return block({ level: 'block', reason: `同时运行的子代理有 ${active.size} 个，超过这个任务允许的 ${maxSubagents} 个` }, 'Agent');
				return;
			}
			if (ev.type === 'system' && ev.task_id && (ev.subtype === 'task_notification' || (ev.subtype === 'task_updated' && ev.patch?.status && ev.patch.status !== 'running'))) {
				active.delete(String(ev.task_id));
				return;
			}
			if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
				for (const block of ev.message.content) {
					if (block?.type !== 'tool_use') continue;
					const v = auditToolCall(String(block.name), block.input, audit);
					if (v.level === 'ok') continue;
					result.violations.push(v);
					onAudit?.(v, String(block.name));
					if (v.level === 'block' || v.level === 'escalation') return 'stop';
				}
				return;
			}
			// 实测格式：rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt(秒)}
			if (ev.type === 'rate_limit_event') {
				const info = ev.rate_limit_info ?? {};
				const windows: QuotaWindows = {};
				for (const [name, w] of Object.entries((info.unifiedWindows ?? {}) as Record<string, any>)) {
					if (typeof w?.utilization === 'number' && w.resetsAt) {
						windows[name] = { utilization: w.utilization, resetsAt: new Date(Number(w.resetsAt) * 1000).toISOString() };
					}
				}
				if (Object.keys(windows).length) result.quota = windows;
				// 实测：overageStatus "rejected" + overageDisabledReason "org_level_disabled" 表示额外用量没开放
				if (info.overageStatus !== undefined || info.isUsingOverage !== undefined) {
					const on = info.isUsingOverage === true || String(info.overageStatus ?? '').startsWith('allowed');
					result.paid = {
						available: on,
						note: info.isUsingOverage
							? '正在使用额外用量（付费）'
							: on
								? '额外用量已开启'
								: `额外用量未开启${info.overageDisabledReason ? `（${info.overageDisabledReason === 'org_level_disabled' ? '账号层面被禁用' : info.overageDisabledReason}）` : ''}`,
					};
				}
				if (info.status === 'rejected') {
					result.errorCode = 'QUOTA_EXHAUSTED';
					if (info.resetsAt) result.resetAt = new Date(Number(info.resetsAt) * 1000).toISOString();
				}
				return;
			}
			if (ev.type === 'result') {
				sawResult = true;
				const u = ev.usage ?? {};
				// 按 API 价格折算的花费；只有付费（api_key）模式下才是真实扣款，订阅模式下仅供参考
				if (typeof ev.total_cost_usd === 'number') result.costUsd = ev.total_cost_usd;
				// result.usage 只含主代理；modelUsage 按模型汇总，包含子代理（实测：输出 1017 vs 2439）。有就用 modelUsage
				const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.values(ev.modelUsage as Record<string, any>) : [];
				if (mu.length) {
					for (const m of mu) {
						result.usage.tokensIn += Number(m.inputTokens) || 0;
						result.usage.tokensOut += Number(m.outputTokens) || 0;
						result.usage.tokensCacheRead += Number(m.cacheReadInputTokens) || 0;
						result.usage.tokensCacheWrite += Number(m.cacheCreationInputTokens) || 0;
					}
				} else {
					result.usage.tokensIn += Number(u.input_tokens) || 0;
					result.usage.tokensOut += Number(u.output_tokens) || 0;
					result.usage.tokensCacheRead += Number(u.cache_read_input_tokens) || 0;
					result.usage.tokensCacheWrite += Number(u.cache_creation_input_tokens) || 0;
				}
				result.finalText = String(ev.result ?? '');
				if (ev.is_error || ev.subtype !== 'success') {
					const text = `${ev.subtype ?? ''} ${ev.result ?? ''} ${(ev.errors ?? []).join(' ')}`;
					result.errorCode ??= classifyErrorText(text) ?? String(ev.subtype ?? 'ERROR').toUpperCase();
					result.errorMessage = text.trim();
					result.resetAt ??= parseResetAt(text);
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
			} else if (sawResult && !result.errorCode) {
				result.outcome = 'completed';
			} else {
				result.outcome = 'error';
				const text = out.stderrTail.trim();
				result.errorCode ??= classifyErrorText(text) ?? 'NO_RESULT';
				result.errorMessage ??= text || '进程结束但没有输出 result 事件';
				result.resetAt ??= parseResetAt(text);
			}
			return result;
		},
	};
}

// 付费模式 + api_key 方式：注入 Console 的 API Key（Claude Code 有这个变量就按 API 计费，不走订阅），
// 并用 --max-budget-usd 限制这一轮最多花多少钱。其余情况一律不带 key，走订阅额度
export function claudeLaunch(
	cfg: CliAgentConfig,
	paid: boolean,
	keyFile: string | null,
): { env: NodeJS.ProcessEnv; extraArgs: string[]; error?: string } {
	if (!paid || cfg.paidMethod !== 'api_key') return { env: workerEnv({}), extraArgs: [] };
	if (!keyFile || !fs.existsSync(keyFile)) return { env: workerEnv({}), extraArgs: [], error: `付费模式需要 Anthropic API Key，请把 key 单独保存到 ${keyFile}` };
	const key = fs.readFileSync(keyFile, 'utf8').replace(/[^\x21-\x7E]/g, '');
	const usd = cfg.paidMaxUsdPerRun ?? DEFAULT_PAID_USD_PER_RUN;
	return { env: workerEnv({ ANTHROPIC_API_KEY: key }), extraArgs: ['--max-budget-usd', String(usd)] };
}

export function createClaudeAdapter(cfg: CliAgentConfig, exe: string, opts: { keyFile?: string | null } = {}): Adapter {
	return {
		name: 'claude',
		async run(input: AgentRunInput): Promise<AgentRunResult> {
			const resume = Boolean(input.sessionId);
			const sessionId = input.sessionId ?? randomUUID();
			const subN = Math.max(0, Math.floor(input.subagents ?? 0));
			const parser = createClaudeParser(sessionId, input.audit, input.onAudit, subN);
			const launch = claudeLaunch(cfg, Boolean(input.paid), opts.keyFile ?? null);
			if (launch.error) return { ...parser.result, outcome: 'error', errorCode: 'INVALID_CREDENTIAL', errorMessage: launch.error };
			const args = claudeArgs(cfg, sessionId, resume, input.allowCommands, subN);
			// --allowedTools 是可变长参数且在最后，额外参数要插到它前面
			const at = args.indexOf('--allowedTools');
			args.splice(at < 0 ? args.length : at, 0, ...launch.extraArgs);
			const out = await runJsonl({
				exe,
				args,
				cwd: input.worktree,
				env: launch.env,
				stdin: input.prompt,
				logFile: input.logFile,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
				onEvent: parser.onEvent,
			});
			return parser.finish(out);
		},
	};
}
