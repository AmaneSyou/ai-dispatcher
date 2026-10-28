import type { AuditContext, AuditVerdict } from '../audit.ts';

export type Usage = { tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheWrite: number };

export type AgentRunInput = {
	taskId: number;
	worktree: string;
	prompt: string;
	sessionId: string | null;
	// 同一任务的多轮共用一个 home，才能用 session 续聊并命中缓存（DSH 用）
	home: string;
	logFile: string;
	timeoutMs: number;
	audit: AuditContext;
	// 项目的验收/自查命令，Claude 只被允许执行这些命令
	allowCommands: string[];
	// 这一轮是否在用付费额度（Claude 的 api_key 方式会据此换成 API Key 运行）
	paid?: boolean;
	// 允许 DSH 内部派几个子代理（0 = 不允许；其他代理忽略）
	subagents?: number;
	signal: AbortSignal;
	onAudit?: (v: AuditVerdict, tool: string) => void;
};

// completed：本轮正常结束（不代表任务做对了，那由验收决定）
// error：模型或环境报错；killed：审计越界被杀；timeout / cancelled 字面意思
export type AgentOutcome = 'completed' | 'error' | 'killed' | 'timeout' | 'cancelled';

export type AgentRunResult = {
	outcome: AgentOutcome;
	errorCode: string | null;
	errorMessage: string | null;
	sessionId: string | null;
	finalText: string;
	usage: Usage;
	violations: AuditVerdict[];
	exitCode: number | null;
	// 额度用完时的恢复时间（能解析出来的话）
	resetAt?: string | null;
	// 订阅额度窗口的使用情况（Claude 的 rate_limit_event 会带上），例如 five_hour / seven_day
	quota?: QuotaWindows | null;
	// 付费额度状态（Claude 的 rate_limit_event 里有 overageStatus）
	paid?: { available: boolean; note: string } | null;
	// 本轮花费（美元，Claude 的 result.total_cost_usd）
	costUsd?: number | null;
	// DSH 子代理的情况（用量已经并进 usage）
	subagents?: { count: number; lines: string[] } | null;
};

export type QuotaWindows = Record<string, { utilization: number; resetsAt: string }>;

export type Adapter = {
	name: string;
	run(input: AgentRunInput): Promise<AgentRunResult>;
};

// 这些错误是环境问题（凭据、额度、网络），不应计入 worker 的失败次数
export const ENV_ERROR_CODES = new Set([
	'INVALID_CREDENTIAL',
	'UNAUTHORIZED',
	'INSUFFICIENT_BALANCE',
	'RATE_LIMITED',
	'QUOTA_EXHAUSTED',
	'MODEL_UNAVAILABLE',
	'NETWORK',
	'SPAWN_FAILED',
]);

export function emptyResult(sessionId: string | null): AgentRunResult {
	return {
		outcome: 'error',
		errorCode: null,
		errorMessage: null,
		sessionId,
		finalText: '',
		usage: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 },
		violations: [],
		exitCode: null,
		resetAt: null,
	};
}
