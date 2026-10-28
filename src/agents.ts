import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClaudeAdapter } from './adapters/claude.ts';
import { createCodexAdapter } from './adapters/codex.ts';
import { createDshAdapter, workerEnv, workerPatch } from './adapters/dsh.ts';
import { resolveClaude, resolveCodex } from './adapters/resolve.ts';
import type { Adapter } from './adapters/types.ts';
import type { Config } from './config.ts';
import { DEFAULT_CLAUDE_KEY_FILE, workPaths } from './config.ts';
import { TOOLS_DIR } from './tools.ts';

export function claudeLoggedIn(exe: string): boolean {
	const r = spawnSync(exe, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, env: workerEnv({}) });
	try {
		return JSON.parse(r.stdout).loggedIn === true;
	} catch {
		return false;
	}
}

export function codexLoggedIn(exe: string): { ok: boolean; text: string } {
	const r = spawnSync(exe, ['login', 'status'], { encoding: 'utf8', windowsHide: true, env: workerEnv({}) });
	const text = `${r.stdout}${r.stderr}`.trim();
	return { ok: r.status === 0 && /logged in/i.test(text), text };
}

// worker 的 PATH 继承自调度器进程；从没重启过的程序里启动时可能还没有 git，这里补上
export function ensureGitOnPath(cfg: Config): void {
	if (!path.isAbsolute(cfg.git)) return;
	const dir = path.dirname(cfg.git);
	const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
	const parts = (process.env[key] ?? '').split(';');
	if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) process.env[key] = [...parts, dir].filter(Boolean).join(';');
}

export function writePatch(cfg: Config): string {
	const file = workPaths(cfg).dshPatch;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, workerPatch(cfg.agents.dsh.model), 'utf8');
	return file;
}

export function agentEnabled(cfg: Config, agent: string): boolean {
	if (agent === 'dsh') return true;
	return Boolean((cfg.agents as Record<string, { enabled?: boolean } | undefined>)[agent]?.enabled);
}

// 按配置组装可用的代理；找不到程序或没登录的代理不进升级链，免得任务升级过去才失败
export function buildAdapters(cfg: Config): { adapters: Record<string, Adapter>; allowedRead: string[]; skipped: string[] } {
	const adapters: Record<string, Adapter> = {
		dsh: createDshAdapter(cfg.agents.dsh, { keyFile: path.join(cfg.workRoot, cfg.agents.dsh.keyFile), patchFile: writePatch(cfg) }),
	};
	// 调度器代码目录本身不让 AI 读，只放开其中的 tools（pnpm、Rust 等工具）
	const allowedRead = [cfg.agents.dsh.install, TOOLS_DIR];
	const skipped: string[] = [];
	const claude = cfg.agents.claude;
	if (claude?.enabled) {
		const exe = resolveClaude(claude.command);
		if (!exe || !fs.existsSync(exe)) skipped.push('claude（找不到程序）');
		else if (!claudeLoggedIn(exe)) skipped.push('claude（命令行未登录）');
		else {
			adapters.claude = createClaudeAdapter(claude, exe, { keyFile: path.join(cfg.workRoot, claude.apiKeyFile ?? DEFAULT_CLAUDE_KEY_FILE) });
			allowedRead.push(path.dirname(exe));
		}
	}
	const codex = cfg.agents.codex;
	if (codex?.enabled) {
		const exe = resolveCodex(codex.command);
		if (!exe || !fs.existsSync(exe)) skipped.push('codex（找不到程序）');
		else if (!codexLoggedIn(exe).ok) skipped.push('codex（未登录）');
		else {
			adapters.codex = createCodexAdapter(codex, exe);
			allowedRead.push(path.dirname(exe));
		}
	}
	return { adapters, allowedRead, skipped };
}
