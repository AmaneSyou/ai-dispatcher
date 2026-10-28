import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workerPatch } from '../src/adapters/dsh.ts';
import { classifyErrorText } from '../src/adapters/jsonl.ts';
import type { Config } from '../src/config.ts';
import { claudeModels, codexModels, dshModels } from '../src/models.ts';
import { applySettings } from '../src/server.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-models-'));

test('Codex：只列出公开模型，按优先级排序，带上各自支持的思考强度', () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, '.codex'));
	fs.writeFileSync(
		path.join(home, '.codex', 'models_cache.json'),
		JSON.stringify({
			fetched_at: '2026-10-28T05:57:44Z',
			models: [
				{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
				{ slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
				{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'medium' }] },
			],
		}),
	);
	const m = codexModels(home);
	assert.deepEqual(m.options.map((o) => o.value), ['gpt-6.1-sol', 'gpt-6-astra']);
	assert.deepEqual(m.options[1].efforts, ['low', 'ultra']);
	assert.equal(m.updatedAt, '2026-10-28T05:57:44Z');
	assert.ok(codexModels(tmp()).error);
});

test('Claude：内置别名 + 账号缓存里的额外选项', () => {
	const home = tmp();
	fs.writeFileSync(
		path.join(home, '.claude.json'),
		JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · 1M' }], other: 'ignored' }),
	);
	const values = claudeModels(home).options.map((o) => o.value);
	assert.deepEqual(values.slice(0, 4), ['fable', 'opus', 'sonnet', 'haiku']);
	assert.ok(values.includes('claude-fable-5-1[1m]'));
});

test('DSH：没有缓存时给默认模型，有缓存时用官方列表', () => {
	const root = tmp();
	const cfg = { workRoot: root } as Config;
	assert.deepEqual(dshModels(cfg).options.map((o) => o.value), ['deepseek-flash']);
	fs.writeFileSync(path.join(root, 'model-cache.json'), JSON.stringify({ ids: ['deepseek-flash', 'deepseek-v4-pro'], updatedAt: '2026-10-28T06:00:00Z' }));
	assert.deepEqual(dshModels(cfg).options.map((o) => o.value), ['deepseek-flash', 'deepseek-v4-pro']);
});

test('DSH 换模型的补丁同时写 provider（补丁会整段替换原配置）', () => {
	assert.ok(!workerPatch().includes('agent-default-model'));
	const p = workerPatch('deepseek-v4-pro');
	assert.match(p, /- id: agent-default-model\n {2}config:\n {4}provider: deepseek-official\n {4}model: deepseek-v4-pro\n/);
	assert.ok(!workerPatch('bad model; rm').includes('agent-default-model'));
});

test('模型下线的报错被识别，普通报错不误判', () => {
	for (const t of [
		'The model `gpt-5.6-luna` does not exist or you do not have access to it.',
		'400 Bad Request: unknown model deepseek-v3.2',
		'Error: model_not_found',
		// 以下两条是 2026-10-28 用不存在的模型名实测得到的原文
		"There's an issue with the selected model (claude-nonexistent-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.",
		'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-nonexistent-model-xyz\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
	]) {
		assert.equal(classifyErrorText(t), 'MODEL_UNAVAILABLE', t);
	}
	assert.equal(classifyErrorText('tests failed: expected 3, got 4'), null);
	assert.equal(classifyErrorText('usage limit reached'), 'QUOTA_EXHAUSTED');
});

test('设置：接受下拉里的各种模型写法和 Codex 的 ultra 强度', () => {
	const cfg = {
		workRoot: tmp(),
		git: 'git',
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, keyFile: 'k', dailyTokenBudget: 1 } },
		projects: {},
	} as Config;
	const base = { enabled: true, concurrency: 1, maxAttempts: 1, timeoutMinutes: 10 };
	applySettings(cfg, {
		agents: {
			dsh: { concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, dailyTokenBudget: 1, model: 'deepseek-v4-pro' },
			claude: { ...base, model: 'claude-fable-5-1[1m]', effort: 'max' },
			codex: { ...base, model: 'gpt-6-astra', effort: 'ultra' },
		},
	});
	assert.equal(cfg.agents.dsh.model, 'deepseek-v4-pro');
	assert.equal(cfg.agents.claude?.model, 'claude-fable-5-1[1m]');
	assert.equal(cfg.agents.codex?.effort, 'ultra');
	assert.throws(() => applySettings(cfg, { agents: { claude: { ...base, effort: 'ultra' } } }), /思考强度无效/);
	// 选“默认”时清空
	applySettings(cfg, { agents: { dsh: { concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, dailyTokenBudget: 1, model: '' } } });
	assert.equal(cfg.agents.dsh.model, undefined);
});
