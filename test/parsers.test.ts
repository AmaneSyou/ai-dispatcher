import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedToolPatterns, claudeArgs, createClaudeParser } from '../src/adapters/claude.ts';
import { codexArgs, createCodexParser } from '../src/adapters/codex.ts';
import { createDshParser } from '../src/adapters/dsh.ts';
import type { JsonlRunOutput } from '../src/adapters/jsonl.ts';
import { classifyErrorText, parseResetAt } from '../src/adapters/jsonl.ts';
import type { AuditContext } from '../src/audit.ts';

const audit: AuditContext = {
	worktree: 'G:\\AgentWork\\wt\\demo-9',
	sensitive: ['C:\\Users\\user\\.codex', 'G:\\AgentWork\\secrets'],
	allowedRead: [],
};
const ok: JsonlRunOutput = { exitCode: 0, stopReason: null, spawnError: null, stderrTail: '' };
const feed = (p: { onEvent: (e: Record<string, any>) => 'stop' | void }, lines: string[]) =>
	lines.map((l) => p.onEvent(JSON.parse(l)));

// 以下 Codex 事件是 2026-10-28 用 codex-cli 0.164 实测输出的原样内容
const CODEX_REAL = [
	'{"type":"thread.started","thread_id":"01a180e4-84fc-74c0-a1bc-4a5cd79ba256"}',
	'{"type":"turn.started"}',
	'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"我会运行 `node --version` 查看版本。\\n"}}',
	'{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"\\"C:\\\\\\\\Windows\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\" -Command \'node --version\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
	'{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"\\"C:\\\\\\\\Windows\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\" -Command \'node --version\'","aggregated_output":"v24.22.1\\r\\n","exit_code":0,"status":"completed"}}',
	'{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"当前 Node.js 版本是 v24.22.1。"}}',
	'{"type":"turn.completed","usage":{"input_tokens":29025,"cached_input_tokens":26752,"cache_write_input_tokens":0,"output_tokens":70,"reasoning_output_tokens":0}}',
];

test('Codex：实测事件流解析出会话、最终回复和扣除缓存后的 token', () => {
	const p = createCodexParser(null, audit);
	assert.ok(feed(p, CODEX_REAL).every((x) => x === undefined));
	const r = p.finish(ok);
	assert.equal(r.outcome, 'completed');
	assert.equal(r.sessionId, '01a180e4-84fc-74c0-a1bc-4a5cd79ba256');
	assert.equal(r.finalText, '当前 Node.js 版本是 v24.22.1。');
	assert.equal(r.usage.tokensIn, 29025 - 26752);
	assert.equal(r.usage.tokensCacheRead, 26752);
	assert.equal(r.usage.tokensOut, 70);
	// 调用 Windows 自带的 powershell.exe 不算越界
	assert.equal(r.violations.length, 0);
});

test('Codex：读凭据的命令被审计终止，额度错误被识别', () => {
	const p = createCodexParser(null, audit);
	const stop = p.onEvent({
		type: 'item.started',
		item: { id: 'x', type: 'command_execution', command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-Content C:\\\\Users\\\\user\\\\.codex\\\\auth.json\'' },
	});
	assert.equal(stop, 'stop');

	const q = createCodexParser(null, audit);
	q.onEvent({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 2026-10-28T09:00:00Z." } });
	const r = q.finish(ok);
	assert.equal(r.outcome, 'error');
	assert.equal(r.errorCode, 'QUOTA_EXHAUSTED');
	assert.equal(r.resetAt, '2026-10-28T09:00:00.000Z');
});

test('Codex：续聊用 exec resume，首轮用 -C 指定工作区', () => {
	const cfg = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 };
	const first = codexArgs(cfg, 'G:\\wt', null);
	assert.deepEqual(first.slice(0, 2), ['exec', '--json']);
	assert.ok(first.includes('windows.sandbox="unelevated"'));
	assert.equal(first[first.indexOf('-C') + 1], 'G:\\wt');
	const again = codexArgs(cfg, 'G:\\wt', 'abc');
	assert.deepEqual(again.slice(0, 3), ['exec', 'resume', '--json']);
	assert.deepEqual(again.slice(-2), ['abc', '-']);
});

// Claude 的 stream-json 格式按官方文档构造；CLI 登录后需用真实输出再核对一次
const CLAUDE_SAMPLE = [
	'{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555","tools":["Read","Edit"]}',
	'{"type":"assistant","session_id":"11111111-2222-3333-4444-555555555555","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"G:\\\\AgentWork\\\\wt\\\\demo-9\\\\src\\\\a.js","old_string":"x","new_string":"y"}}]}}',
	'{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
	'{"type":"result","subtype":"success","is_error":false,"result":"完成","session_id":"11111111-2222-3333-4444-555555555555","usage":{"input_tokens":120,"cache_creation_input_tokens":3000,"cache_read_input_tokens":9000,"output_tokens":400}}',
];

test('Claude：解析会话、结果和 token；工作区内编辑放行', () => {
	const p = createClaudeParser('11111111-2222-3333-4444-555555555555', audit);
	assert.ok(feed(p, CLAUDE_SAMPLE).every((x) => x === undefined));
	const r = p.finish(ok);
	assert.equal(r.outcome, 'completed');
	assert.equal(r.finalText, '完成');
	assert.equal(r.usage.tokensIn, 120);
	assert.equal(r.usage.tokensCacheWrite, 3000);
	assert.equal(r.usage.tokensCacheRead, 9000);
});

test('Claude：写工作区外被终止；未登录被识别为环境问题', () => {
	const p = createClaudeParser('s', audit);
	const stop = p.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:\\Users\\user\\x.txt' } }] } });
	assert.equal(stop, 'stop');

	const q = createClaudeParser('s', audit);
	q.onEvent({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
	assert.equal(q.finish(ok).errorCode, 'UNAUTHORIZED');
});

test('Claude 参数：受限模式、无人审批、只放行项目命令', () => {
	const args = claudeArgs({ enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 }, 'sid', false, ['node --test']);
	for (const f of ['-p', '--restricted', '--strict-mcp-config', '--permission-prompts']) assert.ok(args.includes(f), f);
	assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
	assert.equal(args[args.indexOf('--session-id') + 1], 'sid');
	const allowed = args.slice(args.indexOf('--allowedTools') + 1);
	assert.ok(allowed.includes('Bash(node --test *)'));
	assert.ok(allowed.includes('PowerShell(git status)'));
	assert.ok(!allowed.some((x) => x.startsWith('--')));
	assert.ok(claudeArgs({ enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 }, 'sid', true, []).includes('--resume'));
	assert.deepEqual(allowedToolPatterns([]).length, 16);
});

// 取自 2026-10-28 任务 #5 的真实 Claude 输出（Claude Code 2.1.308）
const CLAUDE_REAL_RATE =
	'{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793175600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.46,"resetsAt":1793175600},"seven_day":{"utilization":0.08,"resetsAt":1793178000}}},"uuid":"472934ab-0314-4e0e-9443-dae96b110616","session_id":"582adac1-afe8-4bc6-9723-a564c0b7e4db"}';
const CLAUDE_REAL_RESULT =
	'{"type":"result","subtype":"success","is_error":false,"num_turns":6,"result":"完成","session_id":"582adac1-afe8-4bc6-9723-a564c0b7e4db","usage":{"input_tokens":8,"cache_creation_input_tokens":4643,"cache_read_input_tokens":45893,"output_tokens":1611}}';

test('Claude：真实输出里的订阅额度窗口被记录，额度未用完时不算错误', () => {
	const p = createClaudeParser('582adac1-afe8-4bc6-9723-a564c0b7e4db', audit);
	feed(p, [CLAUDE_REAL_RATE, CLAUDE_REAL_RESULT]);
	const r = p.finish(ok);
	assert.equal(r.outcome, 'completed');
	assert.equal(r.resetAt, null);
	assert.deepEqual(r.quota, {
		five_hour: { utilization: 0.46, resetsAt: new Date(1793175600 * 1000).toISOString() },
		seven_day: { utilization: 0.08, resetsAt: new Date(1793178000 * 1000).toISOString() },
	});
	assert.equal(r.usage.tokensCacheWrite, 4643);

	const q = createClaudeParser('s', audit);
	q.onEvent(JSON.parse(CLAUDE_REAL_RATE.replace('"status":"allowed"', '"status":"rejected"')));
	assert.equal(q.finish(ok).errorCode, 'QUOTA_EXHAUSTED');
});

// DSH 事件取自 2026-10-28 任务 #2 的真实日志
test('DSH：实测事件解析', () => {
	const p = createDshParser(null, { ...audit, worktree: 'G:\\AgentWork\\wt\\demo-2-20261028-135734' });
	feed(p, [
		'{"type":"session","sessionId":"session-abc","cwd":"G:\\\\AgentWork\\\\wt\\\\demo-2-20261028-135734"}',
		'{"type":"tool_call","callId":"c1","tool":"pwsh","input":{"command":"node --test","workdir":"G:\\\\AgentWork\\\\wt\\\\demo-2-20261028-135734"}}',
		'{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":500,"outputTokens":100,"cacheReadTokens":6000,"cacheWriteTokens":0}}',
		'{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
		'{"type":"final","text":"完成"}',
	]);
	const r = p.finish(ok);
	assert.equal(r.outcome, 'completed');
	assert.equal(r.sessionId, 'session-abc');
	assert.equal(r.usage.tokensCacheRead, 6000);
	assert.equal(r.violations.length, 0);
});

test('错误文案分类与恢复时间解析', () => {
	assert.equal(classifyErrorText('Claude AI usage limit reached|1761642000'), 'QUOTA_EXHAUSTED');
	assert.equal(parseResetAt('Claude AI usage limit reached|1761642000'), new Date(1761642000 * 1000).toISOString());
	assert.equal(classifyErrorText('stream disconnected before completion'), 'NETWORK');
	assert.equal(classifyErrorText('tests failed at line 401'), null);
});

test('Claude 用量：有 modelUsage 时用它（包含子代理），实测数据', () => {
	const p = createClaudeParser('s', audit);
	// 2026-10-28 放行 Agent 工具、Haiku 模型、派 2 个子代理的实测 result（节选）
	p.onEvent({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'ok',
		usage: { input_tokens: 4, cache_creation_input_tokens: 9507, cache_read_input_tokens: 7874, output_tokens: 1017 },
		modelUsage: { 'claude-haiku-5-5': { inputTokens: 12, outputTokens: 2439, cacheReadInputTokens: 24564, cacheCreationInputTokens: 17795, costUSD: 0.0044 } },
	});
	const r = p.finish(ok);
	assert.equal(r.usage.tokensOut, 2439);
	assert.equal(r.usage.tokensCacheRead, 24564);
	assert.equal(r.usage.tokensCacheWrite, 17795);
});

test('Claude 子代理的工具调用在事件流里带 parent_tool_use_id，照样被审计', () => {
	const p = createClaudeParser('s', audit);
	const stop = p.onEvent({
		type: 'assistant',
		parent_tool_use_id: 'toolu_01GauLskA2i631DVgScoT3Mw',
		message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'G:/AgentWork/probe-cc/claude-outside.txt', content: 'test' } }] },
	});
	assert.equal(stop, 'stop');
});

test('Codex：默认关闭子代理（multi_agent 实测默认开启）', () => {
	const args = codexArgs({ enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 }, 'G:/wt', null);
	assert.ok(args.includes('features.multi_agent=false'));
});
