import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { workerPatch } from '../src/adapters/dsh.ts';
import { parseSession, SubagentWatcher, zstdAvailable } from '../src/adapters/subagents.ts';
import type { Task } from '../src/db.ts';
import { firstPrompt } from '../src/prompts.ts';

// 记录格式取自 2026-10-28 实测的 DSH 子代理会话文件（session.v4.jsonl.zstd）
function sessionText(id: string, parent: string, createdAt: number, calls: [string, object][]): string {
	const recs: object[] = [{ type: 'session', version: 4, id, createdAt, cwd: 'G:\\wt', parentSession: parent, origin: 'subagent', delegationDepth: 1 }];
	calls.forEach(([name, args], i) => {
		recs.push({ type: 'tool/call', seq: 10 + i, data: { turn: 1, step: i + 1, callId: `call_${i}`, name, arguments: JSON.stringify(args) } });
		recs.push({ type: 'assistant/message', seq: 20 + i, data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0 }, stream: [{ chunk: { usage: { inputTokens: 100 } } }] } });
	});
	return `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

test('解析子代理会话：工具调用和用量（stream 分片里的用量不重复计）', () => {
	const s = parseSession(sessionText('sub-1', 'main-1', 5, [['read', { file_path: 'G:\\wt\\a.txt' }], ['pwsh', { command: 'Get-ChildItem' }]]))!;
	assert.equal(s.origin, 'subagent');
	assert.equal(s.parent, 'main-1');
	assert.deepEqual(s.calls.map((c) => c.name), ['read', 'pwsh']);
	assert.deepEqual(s.calls[0].args, { file_path: 'G:\\wt\\a.txt' });
	assert.equal(s.usage.tokensIn, 200);
	assert.equal(s.usage.tokensOut, 100);
	// 最后一行没写完也不影响前面的记录
	assert.equal(parseSession(`${sessionText('x', 'm', 1, [['read', {}]])}{"type":"tool/ca`)?.calls.length, 1);
});

test('子代理监视：越界操作被发现并要求终止；同一调用不重复报告；旧会话不计', { skip: !zstdAvailable }, () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-sub-'));
	const dir = path.join(home, 'sessions', '--G-wt--');
	const write = (id: string, text: string) => {
		fs.mkdirSync(path.join(dir, id), { recursive: true });
		const f = path.join(dir, id, 'session.v4.jsonl.zstd');
		fs.writeFileSync(f, (zlib as any).zstdCompressSync(Buffer.from(text)));
		return f;
	};
	const since = Date.now();
	// 上一轮留下的旧子代理：文件时间早于本轮开始，忽略
	const old = write('sub-old', sessionText('sub-old', 'main-1', since - 600_000, [['read', { file_path: 'C:\\Users\\user\\.codex\\auth.json' }]]));
	fs.utimesSync(old, new Date(since - 600_000), new Date(since - 600_000));

	const violations: string[] = [];
	const w = new SubagentWatcher({
		home,
		since,
		audit: { worktree: 'G:\\wt', sensitive: ['C:\\Users\\user\\.codex'], allowedRead: [] },
		onViolation: (v) => violations.push(`${v.level}:${v.reason}`),
	});
	w.mainSessionId = 'main-1';
	write('sub-a', sessionText('sub-a', 'main-1', since + 10, [['read', { file_path: 'G:\\wt\\a.txt' }]]));
	assert.equal(w.scan(), null, '工作区内读取放行');

	write('sub-a', sessionText('sub-a', 'main-1', since + 10, [['read', { file_path: 'G:\\wt\\a.txt' }], ['write', { file_path: 'G:\\outside.txt', content: 'x' }]]));
	const v = w.scan();
	assert.equal(v?.level, 'block');
	assert.match(v?.reason ?? '', /子代理 sub-a/);
	assert.equal(w.scan(), null, '同一个调用只报告一次');
	assert.equal(violations.length, 1);

	// 别的主会话派出的子代理（例如同目录的其他任务）不归这一轮管
	write('sub-x', sessionText('sub-x', 'other-main', since + 20, [['write', { file_path: 'G:\\elsewhere.txt' }]]));
	assert.equal(w.scan(), null);

	const s = w.summary();
	assert.equal(s.count, 1);
	assert.equal(s.usage.tokensIn, 200);
	assert.match(s.lines[0], /2 次工具调用（read、write）/);
});

test('允许子代理时的补丁：只开派出 / 消息 / 查看进度，限制数量和层级；不允许时全部关闭', () => {
	const off = workerPatch();
	assert.match(off, /- id: tool-subagent\n {2}disabled: true/);
	const on = workerPatch(undefined, 3);
	assert.ok(!/- id: tool-subagent\n/.test(on), '派出子代理的工具要打开');
	assert.ok(!on.includes('tool-subagent-control'), '子代理要用 send_message 回报');
	assert.match(on, /- id: tool-subagent-fork\n {2}disabled: true/);
	assert.match(on, /- id: tool-workflow\n {2}disabled: true/);
	assert.match(on, /- id: tool-web\n {2}disabled: true/);
	assert.match(on, /maxDepth: 1\n {4}maxActiveSubagents: 3/);
	assert.match(workerPatch(undefined, 99), /maxActiveSubagents: 6/, '上限 6 个');
});

test('派给 DSH 的说明：允许子代理才写分工规则；不允许时明确禁止', () => {
	const task = { title: 't', spec: 's', allow: [], readonly: [], agent: 'dsh', subagent_limits: { dsh: 2 } } as unknown as Task;
	const project = { repo: '', baseBranch: 'main', gates: [] };
	const p = firstPrompt(task, project, []);
	assert.match(p, /## 子代理/);
	assert.match(p, /最多 2 个子代理/);
	assert.ok(!p.includes('不要使用子代理'));
	const off = firstPrompt({ ...task, subagent_limits: {} } as Task, project, []);
	assert.ok(!off.includes('## 子代理'));
	assert.match(off, /不要使用子代理/);
});

test('Claude：允许子代理才放行 Agent 工具；同时运行超过上限、或不允许时出现子代理，都终止', async () => {
	const { claudeArgs, createClaudeParser } = await import('../src/adapters/claude.ts');
	const cfg = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 };
	const tools = (n: number) => { const a = claudeArgs(cfg, 's', false, [], n); return a[a.indexOf('--tools') + 1]; };
	assert.ok(!tools(0).includes('Agent'));
	assert.ok(tools(2).split(',').includes('Agent'));

	const audit = { worktree: 'G:/wt', sensitive: [], allowedRead: [] };
	const p = createClaudeParser('s', audit, undefined, 2);
	// 事件格式取自 2026-10-28 实测：system task_started / task_notification
	assert.equal(p.onEvent({ type: 'system', subtype: 'task_started', task_id: 'a1', description: '读 a.txt' }), undefined);
	assert.equal(p.onEvent({ type: 'system', subtype: 'task_started', task_id: 'a2', description: '读 b.txt' }), undefined);
	assert.equal(p.onEvent({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' }), undefined);
	assert.equal(p.onEvent({ type: 'system', subtype: 'task_started', task_id: 'a3', description: '第三个，但前一个已结束' }), undefined);
	assert.equal(p.onEvent({ type: 'system', subtype: 'task_started', task_id: 'a4', description: '同时第三个' }), 'stop');
	assert.equal(p.result.subagents?.count, 4);
	assert.match(p.result.subagents?.lines[0] ?? '', /读 a\.txt/);

	const q = createClaudeParser('s', audit, undefined, 0);
	assert.equal(q.onEvent({ type: 'system', subtype: 'task_started', task_id: 'x' }), 'stop');
});

test('Codex：允许子代理才去掉关闭参数；解析子代理的 rollout（实测格式）', async () => {
	const { codexArgs } = await import('../src/adapters/codex.ts');
	const { parseCodexRolloutText } = await import('../src/adapters/subagents.ts');
	const cfg = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1 };
	assert.ok(codexArgs(cfg, 'G:/wt', null).includes('features.multi_agent=false'));
	const on = codexArgs(cfg, 'G:/wt', null, true);
	assert.ok(!on.includes('features.multi_agent=false'));
	assert.equal(on.filter((x) => x === '-c').length, codexArgs(cfg, 'G:/wt', null).filter((x) => x === '-c').length - 1);

	const r = parseCodexRolloutText(codexRollout('child-1', 'main-1', [
		['custom_tool_call', 'exec', 'text(await tools.exec_command({cmd:"Get-Content G:/wt/a.txt","workdir":"G:/wt"}))'],
		['function_call', 'exec_command', JSON.stringify({ cmd: 'Get-ChildItem', workdir: 'G:/wt' })],
		['custom_tool_call', 'apply_patch', '*** Begin Patch\n*** Update File: G:/wt/src/a.js\n@@\n-x\n+y\n*** End Patch'],
	]))!;
	assert.equal(r.parent, 'main-1');
	assert.deepEqual(r.calls.map((c) => c.tool), ['shell', 'shell', 'write']);
	assert.deepEqual((r.calls[2].input as { paths: string[] }).paths, ['G:/wt/src/a.js']);
	assert.equal(r.usage.tokensIn, 48561 - 38528);
	assert.equal(r.usage.tokensCacheRead, 38528);
});

function codexRollout(id: string, parent: string | null, calls: [string, string, string][]): string {
	const lines: object[] = [
		{ timestamp: '2026-10-28T10:10:25Z', type: 'session_meta', payload: { id, cwd: 'G:/wt', originator: 'codex_exec', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/agent_a' } } } : 'exec' } },
	];
	calls.forEach(([type, name, body], i) => lines.push({ type: 'response_item', payload: type === 'custom_tool_call' ? { type, name, input: body, call_id: `c${i}` } : { type, name, arguments: body, call_id: `c${i}` } }));
	lines.push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 48561, cached_input_tokens: 38528, output_tokens: 86, reasoning_output_tokens: 0 } } } });
	return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

test('Codex 子代理监视：越界改文件被发现；超过数量终止；别的线程的子代理不管', async () => {
	const { CodexSubagentWatcher } = await import('../src/adapters/subagents.ts');
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-codexsub-'));
	const since = Date.now();
	const d = new Date(since);
	const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
	fs.mkdirSync(dir, { recursive: true });
	const put = (name: string, text: string) => fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), text);
	const flagged: string[] = [];
	const w = new CodexSubagentWatcher({
		home,
		since,
		max: 2,
		audit: { worktree: 'G:/wt', sensitive: [], allowedRead: [] },
		mainThreadId: () => 'main-1',
		onViolation: (v) => flagged.push(v.reason),
	});
	put('main', codexRollout('main-1', null, [['custom_tool_call', 'spawn_agent', '{}']]));
	put('a', codexRollout('child-a', 'main-1', [['function_call', 'exec_command', JSON.stringify({ cmd: 'Get-ChildItem', workdir: 'G:/wt' })]]));
	put('other', codexRollout('child-x', 'someone-else', [['custom_tool_call', 'apply_patch', '*** Update File: G:/elsewhere.txt']]));
	assert.equal(w.scan(), null);

	put('b', codexRollout('child-b', 'main-1', [['custom_tool_call', 'apply_patch', '*** Begin Patch\n*** Add File: G:/outside.txt\n+hi\n*** End Patch']]));
	assert.equal(w.scan()?.level, 'block');
	assert.ok(flagged.some((r) => /child-b/.test(r) || /子代理/.test(r)));

	put('c', codexRollout('child-c', 'main-1', []));
	assert.match(w.scan()?.reason ?? '', /超过允许的 2 个/);
	const s = w.summary();
	assert.equal(s.count, 3);
	assert.equal(s.usage.tokensCacheRead, 38528 * 3);
});

test('交给 Claude / Codex 的说明里，按各自的工具名写子代理规则', () => {
	const project = { repo: '', baseBranch: 'main', gates: [] };
	const base = { title: 't', spec: 's', allow: [], readonly: [], subagent_limits: { claude: 3, codex: 3 } };
	assert.match(firstPrompt({ ...base, agent: 'claude' } as unknown as Task, project, []), /Agent 工具同时派出最多 3 个/);
	assert.match(firstPrompt({ ...base, agent: 'codex' } as unknown as Task, project, []), /spawn_agent）这一轮总共最多派 3 个/);
	assert.match(firstPrompt({ ...base, agent: 'codex', subagent_limits: { claude: 3 } } as unknown as Task, project, []), /不要使用子代理/);
});
