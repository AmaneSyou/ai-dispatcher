import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandEnv } from '../util.ts';

// 在 root 下最多两层子目录里找 exe，取最近修改的一个（桌面 App 的内置 CLI 目录名带版本哈希，更新后会变）
function newestUnder(root: string, exe: string): string | null {
	if (!fs.existsSync(root)) return null;
	const hits: { file: string; mtime: number }[] = [];
	const walk = (dir: string, depth: number) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isFile() && e.name.toLowerCase() === exe) hits.push({ file: p, mtime: fs.statSync(p).mtimeMs });
			else if (e.isDirectory() && depth > 0) walk(p, depth - 1);
		}
	};
	walk(root, 2);
	hits.sort((a, b) => b.mtime - a.mtime);
	return hits[0]?.file ?? null;
}

// Claude 桌面版是应用商店包：它写进 %APPDATA% 的文件实际落在 Packages\Claude_*\LocalCache\Roaming 下，
// 只有包内进程能在 %APPDATA% 看到。从普通终端启动调度器时必须去真实位置找
function packagedClaudeRoots(): string[] {
	const pkgs = path.join(process.env.LOCALAPPDATA ?? '', 'Packages');
	if (!fs.existsSync(pkgs)) return [];
	return fs
		.readdirSync(pkgs)
		.filter((n) => /^Claude_/i.test(n))
		.map((n) => path.join(pkgs, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
}

// 2026-10-28 实测：桌面 App 升级后把内置 CLI 挪到了 %LOCALAPPDATA%\Claude-Data\claude_<包ID>\claude-code\<版本>\<哈希>\
function claudeDataRoots(): string[] {
	const base = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
	if (!fs.existsSync(base)) return [];
	return fs
		.readdirSync(base)
		.map((n) => path.join(base, n, 'claude-code'))
		.filter((p) => fs.existsSync(p));
}

// 优先用配置里写死的路径，其次是独立安装版；否则在桌面 App 用过的所有位置里找，取最新的一份。
// App 每次升级都可能换位置，所以不能只认一个目录
export function resolveClaude(configured?: string): string | null {
	if (configured) return expandEnv(configured);
	const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
	if (fs.existsSync(local)) return local;
	const roots = [...claudeDataRoots(), ...packagedClaudeRoots(), path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code')];
	const hits = roots
		.map((r) => newestUnder(r, 'claude.exe'))
		.filter((f): f is string => Boolean(f))
		.map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	return hits[0]?.f ?? null;
}

export function resolveCodex(configured?: string): string | null {
	if (configured) return expandEnv(configured);
	return newestUnder(path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin'), 'codex.exe');
}
