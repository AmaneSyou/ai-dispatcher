import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeParser } from '../src/adapters/claude.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { dispatchState, parseCodexRollout } from '../src/quota.ts';

const audit = { worktree: 'G:/x', sensitive: [], allowedRead: [] };

test('Claude：从真实 rate_limit_event 读出“额外用量未开启（账号层面被禁用）”', () => {
	const p = createClaudeParser('s', audit);
	p.onEvent({
		type: 'rate_limit_event',
		rate_limit_info: { status: 'allowed', resetsAt: 1793175600, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.46, resetsAt: 1793175600 } } },
	});
	assert.deepEqual(p.result.paid, { available: false, note: '额外用量未开启（账号层面被禁用）' });
});

test('Codex：从会话记录读出充值余额', () => {
	const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 90, window_minutes: 300, resets_at: 4102444800 }, credits: { has_credits: true, unlimited: false, balance: '667.0159090000' } } } });
	const q = parseCodexRollout(line, 'x')!;
	assert.equal(q.paid?.available, true);
	assert.equal(q.paid?.balance, 667.015909);
});

function setup(extra: Partial<Config['agents']['codex']> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-paid-'));
	const store = new Store(path.join(root, 'db.sqlite'));
	const cfg = {
		workRoot: root,
		agents: {
			dsh: {},
			claude: { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, usePaid: true, paidDailyMaxRuns: 2 },
			codex: { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, ...extra },
		},
	} as unknown as Config;
	// Claude 5 小时窗口只剩 5%，低于默认保留线 15%
	store.setAgentQuota('claude', { five_hour: { utilization: 0.95, resetsAt: new Date(Date.now() + 3600_000).toISOString() } }, '测试');
	return { cfg, store };
}

test('付费模式：开启后越过保留线继续派发，到每日上限就停；没开放付费额度也会停', () => {
	const { cfg, store } = setup();
	let d = dispatchState(cfg, store, 'claude');
	assert.equal(d.block, null);
	assert.equal(d.paidMode, true);
	const tid = store.createTask({ project: 'p', title: 't', spec: 's', allow: [], readonly: [], agent: 'claude', maxAttempts: 1 });
	store.addAttempt(tid, 1, 'claude', 'x', true);
	store.addAttempt(tid, 2, 'claude', 'x', true);
	d = dispatchState(cfg, store, 'claude');
	assert.match(d.block ?? '', /每日上限 2/);

	store.setAgentPaid('claude', { available: false, note: '额外用量未开启（账号层面被禁用）' });
	cfg.agents.claude!.paidDailyMaxRuns = 10;
	assert.match(dispatchState(cfg, store, 'claude').block ?? '', /没有可用的付费额度.*账号层面被禁用/);

	cfg.agents.claude!.usePaid = false;
	assert.match(dispatchState(cfg, store, 'claude').block ?? '', /只剩 5%/);
});

test('Claude API Key 付费方式：只有付费模式才带 key，并限制每轮花费', async () => {
	const { claudeLaunch, createClaudeParser: parser } = await import('../src/adapters/claude.ts');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-key-'));
	const keyFile = path.join(root, 'anthropic.key');
	const cfg = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, paidMethod: 'api_key' as const, paidMaxUsdPerRun: 1.5 };
	assert.equal(claudeLaunch(cfg, false, keyFile).env.ANTHROPIC_API_KEY, undefined, '不是付费模式不带 key');
	assert.equal(claudeLaunch({ ...cfg, paidMethod: 'extra_usage' }, true, keyFile).env.ANTHROPIC_API_KEY, undefined, '额外用量方式不带 key');
	assert.match(claudeLaunch(cfg, true, keyFile).error ?? '', /需要 Anthropic API Key/);
	fs.writeFileSync(keyFile, 'sk-ant-test-123\r\n');
	const l = claudeLaunch(cfg, true, keyFile);
	assert.equal(l.env.ANTHROPIC_API_KEY, 'sk-ant-test-123');
	assert.deepEqual(l.extraArgs, ['--max-budget-usd', '1.5']);

	const p = parser('s', audit);
	p.onEvent({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.42, usage: {} });
	assert.equal(p.result.costUsd, 0.42);
});

test('Claude API Key 付费方式：没放 key 或今天花到上限都会停', () => {
	const { cfg, store } = setup();
	Object.assign(cfg.agents.claude!, { paidMethod: 'api_key', paidDailyMaxUsd: 1 });
	assert.match(dispatchState(cfg, store, 'claude').block ?? '', /没有找到 key 文件/);
	fs.mkdirSync(path.join(cfg.workRoot, 'secrets'));
	fs.writeFileSync(path.join(cfg.workRoot, 'secrets', 'anthropic.key'), 'sk-ant-x');
	// 额外用量被禁用不影响 API Key 方式
	store.setAgentPaid('claude', { available: false, note: '额外用量未开启' });
	assert.equal(dispatchState(cfg, store, 'claude').paidMode, true);
	const tid = store.createTask({ project: 'p', title: 't', spec: 's', allow: [], readonly: [], agent: 'claude', maxAttempts: 1 });
	const at = store.addAttempt(tid, 1, 'claude', 'x', true);
	store.finishAttempt(at, { outcome: 'completed', tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costUsd: 1.2, finalText: '' });
	assert.match(dispatchState(cfg, store, 'claude').block ?? '', /今天 API 已花 \$1\.20，到达每日上限 \$1/);
});
