// 三家代理的可选模型列表。都从“会自己更新”的来源读，模型新增或下线时列表跟着变：
// - Claude：别名（fable / opus / sonnet / haiku）始终指向该系列最新版，再加上账号缓存里的额外选项
// - Codex：Codex App 维护的 ~/.codex/models_cache.json
// - DSH：DeepSeek 官方 GET /models（不消耗 token），结果缓存在工作区，面板可手动刷新
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readKey } from './adapters/dsh.ts';
import type { Config } from './config.ts';

export type ModelOption = { value: string; label: string; description?: string; efforts?: string[] };
export type AgentModels = { options: ModelOption[]; updatedAt?: string; source: string; error?: string };

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CLAUDE_ALIASES: ModelOption[] = [
	{ value: 'fable', label: 'Fable（最强，最耗额度）', description: '自动使用 Fable 系列最新版' },
	{ value: 'opus', label: 'Opus（强，较耗额度）', description: '自动使用 Opus 系列最新版' },
	{ value: 'sonnet', label: 'Sonnet（均衡，省额度）', description: '自动使用 Sonnet 系列最新版' },
	{ value: 'haiku', label: 'Haiku（最快最省）', description: '自动使用 Haiku 系列最新版' },
];

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

export function claudeModels(home = os.homedir()): AgentModels {
	const options = CLAUDE_ALIASES.map((o) => ({ ...o, efforts: CLAUDE_EFFORTS }));
	// 账号可用的额外选项（例如 1M 上下文版本），Claude Code 自己维护这份缓存
	const extra = readJson(path.join(home, '.claude.json'))?.additionalModelOptionsCache;
	if (Array.isArray(extra)) {
		for (const m of extra) {
			if (typeof m?.value !== 'string' || options.some((o) => o.value === m.value)) continue;
			// 模型名末尾的 [1m] 表示 100 万 token 上下文版本
			const label = `${String(m.label ?? m.value)}${/\[1m\]$/i.test(m.value) ? '（100 万上下文，更耗额度）' : ''}`;
			options.push({ value: m.value, label, description: m.description, efforts: CLAUDE_EFFORTS });
		}
	}
	return { options, source: '内置别名（自动跟随最新版）+ Claude 账号缓存' };
}

export function codexModels(home = os.homedir()): AgentModels {
	const file = path.join(home, '.codex', 'models_cache.json');
	const j = readJson(file);
	if (!Array.isArray(j?.models)) return { options: [], source: 'Codex 模型缓存', error: '找不到 Codex 的模型缓存，打开一次 Codex App 后再刷新' };
	const options = j.models
		.filter((m: any) => m?.slug && m.visibility === 'list')
		.sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
		.map((m: any) => ({
			value: String(m.slug),
			label: String(m.display_name ?? m.slug),
			description: m.description,
			efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((x: any) => String(x.effort ?? x)) : undefined,
		}));
	return { options, updatedAt: j.fetched_at, source: 'Codex App 的模型缓存（由 Codex 自动更新）' };
}

function dshCacheFile(cfg: Config): string {
	return path.join(cfg.workRoot, 'model-cache.json');
}

const DSH_FALLBACK: ModelOption[] = [{ value: 'deepseek-flash', label: 'deepseek-flash（DSH 默认）' }];

function dshLabel(id: string): ModelOption {
	if (id === 'deepseek-flash') return { value: id, label: 'deepseek-flash（DSH 默认，便宜快速）' };
	if (/pro/i.test(id)) return { value: id, label: `${id}（更强，更贵）` };
	return { value: id, label: id };
}

export function dshModels(cfg: Config): AgentModels {
	const c = readJson(dshCacheFile(cfg));
	if (Array.isArray(c?.ids) && c.ids.length) {
		return { options: c.ids.map(dshLabel), updatedAt: c.updatedAt, source: 'DeepSeek 官方模型列表' };
	}
	return { options: DSH_FALLBACK, source: '内置默认（点“刷新模型列表”从 DeepSeek 获取）' };
}

// 只查询列表，不调用模型、不花钱；key 只放在请求头里
export async function refreshDshModels(cfg: Config): Promise<AgentModels> {
	const key = readKey(path.join(cfg.workRoot, cfg.agents.dsh.keyFile));
	const r = await fetch('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
	if (!r.ok) throw new Error(`DeepSeek 模型列表获取失败（${r.status}）`);
	const j = (await r.json()) as { data?: { id?: string }[] };
	const ids = (j.data ?? []).map((m) => String(m.id ?? '')).filter((id) => /^[\w.:-]{1,60}$/.test(id));
	if (!ids.length) throw new Error('DeepSeek 返回的模型列表是空的');
	fs.writeFileSync(dshCacheFile(cfg), JSON.stringify({ ids, updatedAt: new Date().toISOString() }, null, '\t'), 'utf8');
	return dshModels(cfg);
}

export function allModels(cfg: Config) {
	return { dsh: dshModels(cfg), claude: claudeModels(), codex: codexModels() };
}
