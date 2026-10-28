import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { parseCodexRollout, quotaBlockReason } from '../src/quota.ts';
import type { AppContext } from '../src/server.ts';
import { applySettings, startServer } from '../src/server.ts';

function makeCtx(): { ctx: AppContext; cfg: Config } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-server-'));
	const cfg: Config = {
		workRoot: root,
		git: 'git',
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: {
			dsh: { install: '', concurrency: 2, maxAttempts: 2, timeoutMinutes: 20, keyFile: 'k', dailyTokenBudget: 1000 },
			claude: { enabled: true, concurrency: 1, maxAttempts: 2, timeoutMinutes: 30 },
		},
		projects: { demo: { repo: root, baseBranch: 'main', gates: [] } },
	};
	process.env.DISPATCHER_CONFIG = path.join(root, 'cfg.json');
	const store = new Store(path.join(root, 'db.sqlite'));
	return { cfg, ctx: { cfg, store, token: 'secret-token', startedAt: new Date().toISOString() } };
}

// 用原始 http 请求，才能伪造 Host / Origin 头
function request(port: number, p: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
	return new Promise<{ status: number; body: any }>((resolve, reject) => {
		const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
		const req = http.request(
			{ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...opts.headers } },
			(res) => {
				let s = '';
				res.on('data', (c) => (s += c));
				res.on('end', () => {
					let body: any = s;
					try {
						body = JSON.parse(s);
					} catch {}
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

test('面板服务：没有口令、外来 Host、外来 Origin 都被拒绝；带口令可以加任务', async (t) => {
	const { ctx } = makeCtx();
	const server = await startServer(ctx, 0);
	t.after(() => server.close());
	const port = (server.address() as { port: number }).port;
	const auth = { 'x-dispatcher-token': 'secret-token' };

	const page = await request(port, '/');
	assert.equal(page.status, 200);
	assert.match(page.body, /secret-token/);

	assert.equal((await request(port, '/api/state')).status, 401);
	assert.equal((await request(port, '/api/state', { headers: { ...auth, host: 'evil.example:80' } })).status, 403);
	assert.equal((await request(port, '/api/tasks', { method: 'POST', headers: { ...auth, origin: 'http://evil.example' }, body: {} })).status, 403);
	assert.equal((await request(port, '/api/tasks', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: {} })).status, 415);
	assert.equal((await request(port, '/api/ping')).body.app, 'ai-dispatcher');

	const bad = await request(port, '/api/tasks', { method: 'POST', headers: auth, body: { project: 'demo', title: '', spec: 'x' } });
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /都要填写/);

	const ok = await request(port, '/api/tasks', { method: 'POST', headers: auth, body: { project: 'demo', title: '面板建的任务', spec: '做点事', allow: ['src/**'], agent: '' } });
	assert.equal(ok.status, 200, JSON.stringify(ok.body));
	const st = await request(port, '/api/state', { headers: auth });
	assert.equal(st.body.tasks[0].title, '面板建的任务');
	assert.equal(st.body.tasks[0].agent, 'dsh');
	assert.equal(st.body.tasks[0].spec, undefined);

	const sub = await request(port, '/api/tasks', { method: 'POST', headers: auth, body: { project: 'demo', title: '子代理分开设置', spec: 's', subagents: { dsh: 4, claude: 0, codex: 9 } } });
	assert.equal(sub.status, 200);
	assert.deepEqual(ctx.store.getTask(sub.body.id)?.subagent_limits, { dsh: 4, codex: 6 }, '0 的不记录，超过上限压到 6');
	const cancel = await request(port, `/api/task/${ok.body.id}/cancel`, { method: 'POST', headers: auth, body: {} });
	assert.equal(cancel.status, 200);
	assert.equal(ctx.store.getTask(ok.body.id)?.status, 'cancelled');
});

test('设置校验：越界数字、非法模型名、重复的升级顺序被拒', () => {
	const { cfg } = makeCtx();
	const base = { enabled: true, concurrency: 1, maxAttempts: 2, timeoutMinutes: 30 };
	assert.throws(() => applySettings(cfg, { agents: { dsh: { concurrency: 99, maxAttempts: 1, timeoutMinutes: 1, dailyTokenBudget: 1 } } }), /1～8/);
	assert.throws(() => applySettings(cfg, { agents: { claude: { ...base, model: 'opus; rm -rf' } } }), /模型名/);
	assert.throws(() => applySettings(cfg, { escalation: ['dsh', 'dsh'] }), /不能重复/);
	assert.throws(() => applySettings(cfg, { quotaGuard: { fiveHourReservePercent: 95, weeklyReservePercent: 15 } }), /0～90/);
	applySettings(cfg, { agents: { claude: { ...base, model: 'sonnet', effort: 'low' } }, escalation: ['dsh', 'claude'], quotaGuard: { fiveHourReservePercent: 20, weeklyReservePercent: 15 } });
	assert.equal(cfg.agents.claude?.model, 'sonnet');
	assert.deepEqual(cfg.escalation, ['dsh', 'claude']);
	assert.equal(cfg.quotaGuard?.weeklyReservePercent, 15);
});

test('Codex 额度：从会话记录解析，剩余降到保留比例时停止派发', () => {
	// 结构取自 2026-10-28 本机 Codex 会话记录
	const line = JSON.stringify({
		timestamp: '2026-10-28T06:10:21.000Z',
		type: 'event_msg',
		payload: {
			type: 'token_count',
			rate_limits: {
				primary: { used_percent: 27.0, window_minutes: 300, resets_at: 1793175792 },
				secondary: { used_percent: 89.0, window_minutes: 10080, resets_at: 1793599810 },
				plan_type: 'plus',
			},
		},
	});
	const q = parseCodexRollout(`{"type":"session_meta"}\n${line}\n{"type":"event_msg","payload":{"rate_limits":null}}\n`, 'x');
	assert.ok(q);
	assert.equal(q.windows.five_hour.utilization, 0.27);
	assert.equal(q.windows.seven_day.utilization, 0.89);
	const now = new Date(1793175000 * 1000);
	// 默认保留 15%：每周只剩 11%，应当停止
	assert.match(quotaBlockReason({} as Config, q, now) ?? '', /每周额度只剩 11%（已到为你保留的 15%）/);
	// 窗口重置之后，旧数据不再挡住派发
	assert.equal(quotaBlockReason({} as Config, q, new Date(1793599900 * 1000)), null);
	assert.equal(quotaBlockReason({ quotaGuard: { fiveHourReservePercent: 15, weeklyReservePercent: 10 } } as Config, q, now), null);
	// 5 小时窗口剩 73%，保留 80% 时也会停
	assert.match(quotaBlockReason({ quotaGuard: { fiveHourReservePercent: 80, weeklyReservePercent: 0 } } as Config, q, now) ?? '', /5 小时额度只剩 73%/);
});

test('旧版配置“用到多少停”自动换算成“保留多少”', async () => {
	const { loadConfig } = await import('../src/config.ts');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-cfg-'));
	const file = path.join(root, 'cfg.json');
	fs.writeFileSync(file, JSON.stringify({ workRoot: root, git: 'git', dashboard: { host: '127.0.0.1', port: 1 }, agents: { dsh: { install: 'x' } }, projects: {}, quotaGuard: { fiveHourStopPercent: 90, weeklyStopPercent: 85 } }));
	process.env.DISPATCHER_CONFIG = file;
	assert.deepEqual(loadConfig().quotaGuard, { fiveHourReservePercent: 10, weeklyReservePercent: 15 });
});

test('Claude /usage 输出解析（实测原文）', async () => {
	const { parseClaudeUsageText, parseResetText } = await import('../src/quota.ts');
	const text = `You are currently using your subscription to power your Claude Code usage

Current session: 85% used · resets Oct 28, 5:19pm (Asia/Tokyo)
Current week (all models): 14% used · resets Oct 28, 5:59pm (Asia/Tokyo)

What's contributing to your limits usage?`;
	const now = new Date(2026, 9, 28, 15, 30);
	const w = parseClaudeUsageText(text, now)!;
	assert.equal(w.five_hour.utilization, 0.85);
	assert.equal(new Date(w.five_hour.resetsAt).getHours(), 17);
	assert.equal(new Date(w.five_hour.resetsAt).getMinutes(), 19);
	assert.equal(w.seven_day.utilization, 0.14);
	assert.equal(new Date(w.seven_day.resetsAt).getDate(), 28);
	assert.equal(parseClaudeUsageText('no usage here', now), null);

	// 12am 是 0 点；没写日期且时间已过 → 明天；12 月底看到 1 月 → 明年
	assert.equal(new Date(parseResetText('resets Nov 2, 12am', now)!).getHours(), 0);
	assert.equal(new Date(parseResetText('resets 9:00am', now)!).getDate(), 29);
	assert.equal(new Date(parseResetText('resets Jan 3, 1pm', new Date(2026, 11, 30))!).getFullYear(), 2027);
});
