import fs from 'node:fs';
import path from 'node:path';
import type { AuditContext, AuditVerdict } from '../audit.ts';
import { auditToolCall } from '../audit.ts';
import type { DshConfig } from '../config.ts';
import { withTools } from '../tools.ts';
import type { JsonlRunOutput } from './jsonl.ts';
import { classifyErrorText, runJsonl } from './jsonl.ts';
import { SubagentWatcher, zstdAvailable } from './subagents.ts';
import type { Adapter, AgentRunInput, AgentRunResult } from './types.ts';
import { emptyResult } from './types.ts';

// 关掉内置子代理（并发统一由调度器控制）和网页工具（减少提示注入入口、省钱）。
// 换模型时要连 provider 一起写：补丁会整段替换原配置（实测），只写 model 会把 provider 丢掉
export function workerPatch(model?: string, subagents = 0): string {
	const m = model && /^[\w.:-]{1,60}$/.test(model) ? `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${model}\n` : '';
	if (!(subagents > 0)) return `${WORKER_PATCH}${m}`;
	// 允许子代理时：只开 subagent（派出）、control（send_message）、list-agents（查看进度）。
	// fork 会复制整段对话，token 翻倍，仍然关闭；子代理不能再派子代理（maxDepth 1）
	const n = Math.max(1, Math.min(6, Math.floor(subagents)));
	return `# 由调度器生成，供 DSH headless worker 使用（本任务允许最多 ${n} 个子代理）
- id: tool-subagent-fork
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-web
  disabled: true
- id: subagent
  config:
    maxDepth: 1
    maxActiveSubagents: ${n}
${m}`;
}

export const WORKER_PATCH = `# 由调度器生成，供 DSH headless worker 使用
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-web
  disabled: true
`;

export const PATCHED_IDS = ['tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-web'];

export function dshPaths(install: string) {
	const asar = path.join(install, 'resources', 'app.asar');
	return {
		exe: path.join(install, 'DeepSeek Harness.exe'),
		// app.asar 是归档文件，只有 Electron 自己能读里面的路径，普通 fs 检查要看归档本身
		asar,
		cli: path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
	};
}

// DSH 的 key 必须是纯 ASCII；粘贴时混进来的换行、全角字符会让请求头非法
export function readKey(file: string): string {
	return fs.readFileSync(file, 'utf8').replace(/[^\x21-\x7E]/g, '');
}

// 只传运行所需的系统变量，避免把其他工具的令牌带进 worker
const PASS_ENV = [
	'SystemRoot',
	'SystemDrive',
	'windir',
	'ComSpec',
	'PATH',
	'Path',
	'PATHEXT',
	'USERPROFILE',
	'USERNAME',
	'USERDOMAIN',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'ProgramData',
	'ProgramFiles',
	'ProgramFiles(x86)',
	'ProgramW6432',
	'CommonProgramFiles',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
	'OS',
	'PSModulePath',
	'TEMP',
	'TMP',
];

export function workerEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
	// AI 也能直接用调度器 tools 目录里的 pnpm、Rust 等（只读）
	return withTools({ ...env, ...extra }, 'worker');
}

export function launchArgs(install: string, patchFile: string, sessionId: string | null): { exe: string; args: string[] } {
	const p = dshPaths(install);
	const args = ['--expose-internals', p.cli, '--profile', 'headless', '--patch', patchFile, '--json'];
	if (sessionId) args.push('--session-id', sessionId);
	// 任务文本走 stdin，避免命令行转义和中文编码问题
	args.push('-');
	return { exe: p.exe, args };
}

// 事件解析与进程管理分开，便于用真实日志做测试
export function createDshParser(sessionId: string | null, audit: AuditContext, onAudit?: (v: AuditVerdict, tool: string) => void) {
	const result = emptyResult(sessionId);
	let sawFinal = false;
	return {
		result,
		onEvent(ev: Record<string, any>): 'stop' | void {
			switch (ev.type) {
				case 'session':
					result.sessionId = ev.sessionId ?? result.sessionId;
					return;
				case 'tool_call': {
					const v = auditToolCall(String(ev.tool), ev.input, audit);
					if (v.level === 'ok') return;
					result.violations.push(v);
					onAudit?.(v, String(ev.tool));
					return v.level === 'block' || v.level === 'escalation' ? 'stop' : undefined;
				}
				case 'status':
					if (ev.phase === 'step_end' && ev.usage) {
						// DSH 的 inputTokens 不含缓存命中部分
						result.usage.tokensIn += Number(ev.usage.inputTokens) || 0;
						result.usage.tokensOut += Number(ev.usage.outputTokens) || 0;
						result.usage.tokensCacheRead += Number(ev.usage.cacheReadTokens) || 0;
						result.usage.tokensCacheWrite += Number(ev.usage.cacheWriteTokens) || 0;
					}
					// 失败原因在 turn_end.reason 里，不一定有单独的 error 事件
					if (ev.phase === 'turn_end' && ev.reason?.kind && ev.reason.kind !== 'completed') {
						result.errorCode = ev.reason.error?.code ?? String(ev.reason.kind).toUpperCase();
						result.errorMessage = ev.reason.error?.message ?? null;
						// DSH 自己的错误码里没有“模型下线”这一类，按报错文字补判
						if (classifyErrorText(`${result.errorCode} ${result.errorMessage ?? ''}`) === 'MODEL_UNAVAILABLE') result.errorCode = 'MODEL_UNAVAILABLE';
					}
					return;
				case 'error':
					result.errorCode ??= classifyErrorText(String(ev.message ?? '')) ?? ev.code ?? 'ERROR';
					result.errorMessage ??= ev.message ?? null;
					return;
				case 'final':
					sawFinal = true;
					result.finalText = String(ev.text ?? '');
					return;
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
			} else if (sawFinal && !result.errorCode) {
				result.outcome = 'completed';
			} else {
				result.outcome = 'error';
				result.errorCode ??= 'NO_FINAL';
				result.errorMessage ??= out.stderrTail.trim() || '进程结束但没有输出 final 事件';
			}
			return result;
		},
	};
}

export function createDshAdapter(cfg: DshConfig, opts: { keyFile: string; patchFile: string }): Adapter {
	return {
		name: 'dsh',
		async run(input: AgentRunInput): Promise<AgentRunResult> {
			let key: string;
			try {
				key = readKey(opts.keyFile);
			} catch {
				return { ...emptyResult(input.sessionId), errorCode: 'INVALID_CREDENTIAL', errorMessage: `读不到 DeepSeek key 文件 ${opts.keyFile}` };
			}
			fs.mkdirSync(input.home, { recursive: true });
			const tmp = path.join(input.home, 'tmp');
			fs.mkdirSync(tmp, { recursive: true });
			const parser = createDshParser(input.sessionId, input.audit, input.onAudit);

			// 允许子代理时：本任务单独生成补丁打开子代理工具，并启动会话文件监视。
			// 读不了 zstd（Node 太旧）就看不到子代理在做什么，宁可不开
			let subN = Math.max(0, Math.floor(input.subagents ?? 0));
			if (subN > 0 && !zstdAvailable) {
				input.onAudit?.({ level: 'warn', reason: '当前 Node 不支持读取 zstd，无法监视子代理，本轮按不允许子代理运行' }, 'subagent');
				subN = 0;
			}
			let patchFile = opts.patchFile;
			if (subN > 0) {
				patchFile = path.join(input.home, 'worker-subagents.patch.yml');
				fs.writeFileSync(patchFile, workerPatch(cfg.model, subN), 'utf8');
			}
			const watcher =
				subN > 0
					? new SubagentWatcher({
							home: input.home,
							since: Date.now(),
							audit: input.audit,
							onViolation: (v, tool) => {
								parser.result.violations.push(v);
								input.onAudit?.(v, tool);
							},
						})
					: null;
			let poll: NodeJS.Timeout | null = null;

			const { exe, args } = launchArgs(cfg.install, patchFile, input.sessionId);
			const out = await runJsonl({
				exe,
				args,
				cwd: input.worktree,
				env: workerEnv({
					ELECTRON_RUN_AS_NODE: '1',
					DSH_HOME: input.home,
					DSH_PERMISSION_MODE: 'workspace-write',
					DEEPSEEK_API_KEY: key,
					TEMP: tmp,
					TMP: tmp,
				}),
				stdin: input.prompt,
				logFile: input.logFile,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
				onEvent: (ev) => {
					if (watcher && ev.type === 'session' && ev.sessionId) watcher.mainSessionId = String(ev.sessionId);
					return parser.onEvent(ev);
				},
				onStart: (stop) => {
					if (!watcher) return;
					// 每秒查一次子代理的会话文件；发现越界立即结束整个 DSH（子代理和主代理在同一进程里）
					poll = setInterval(() => {
						if (watcher.scan()) stop('killed');
					}, 1000);
				},
			});
			if (poll) clearInterval(poll);
			const result = parser.finish(out);
			if (watcher) {
				// 进程结束后再扫一遍，补上最后一秒的记录，并把子代理的 token 并进本轮用量
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
