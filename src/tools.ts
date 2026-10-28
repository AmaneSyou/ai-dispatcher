// AI 干活可能要用的工具（pnpm、Rust 等）装在调度器目录的 tools 下，不改系统 PATH。
// 调度器启动准备命令、验收命令和 AI 时，把装好了的工具加到它们自己的 PATH 前面
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from './config.ts';

export const TOOLS_DIR = path.join(CODE_ROOT, 'tools');

export function toolPaths(root = TOOLS_DIR) {
	return {
		root,
		// 小工具的启动入口（pnpm 等）
		bin: path.join(root, 'bin'),
		rustup: path.join(root, 'rust', 'rustup'),
		cargo: path.join(root, 'rust', 'cargo'),
		corepack: path.join(root, 'corepack'),
		// pnpm 的共享依赖库：各副本用硬链接共用，装依赖快、不重复占空间（要和工作目录在同一个盘）
		pnpmStore: path.join(root, 'pnpm-store'),
		python: path.join(root, 'python'),
	};
}

export type ToolUse = 'gate' | 'worker';

// gate：调度器自己跑的准备 / 验收命令（不在沙盒里）；worker：交给 AI 的环境（沙盒里，只能读这些目录）
export function toolEnv(use: ToolUse, opts: { root?: string; cargoTarget?: string } = {}): { prepend: string[]; vars: Record<string, string> } {
	const p = toolPaths(opts.root);
	const prepend: string[] = [];
	const vars: Record<string, string> = {};
	if (fs.existsSync(p.bin)) prepend.push(p.bin);
	if (fs.existsSync(path.join(p.cargo, 'bin'))) {
		prepend.push(path.join(p.cargo, 'bin'));
		vars.RUSTUP_HOME = p.rustup;
		vars.CARGO_HOME = p.cargo;
		// 验收时各副本共用一个编译缓存目录，第二次起快很多；AI 在沙盒里写不了外面，就用副本里默认的 target
		if (use === 'gate' && opts.cargoTarget) vars.CARGO_TARGET_DIR = opts.cargoTarget;
	}
	if (fs.existsSync(p.corepack)) vars.COREPACK_HOME = p.corepack;
	// pnpm 11 起只认 pnpm_config_ 前缀（实测 12.8.1 不读 npm_config_store_dir，会把依赖库建到盘符根目录）；旧变量名留给老版本
	if (fs.existsSync(p.pnpmStore)) {
		vars.pnpm_config_store_dir = p.pnpmStore;
		vars.npm_config_store_dir = p.pnpmStore;
	}
	if (fs.existsSync(p.python)) prepend.push(p.python, path.join(p.python, 'Scripts'));
	return { prepend, vars };
}

// 把工具加进一份环境变量（Windows 上 PATH 的键名大小写不定）
export function withTools(env: NodeJS.ProcessEnv, use: ToolUse, opts: { root?: string; cargoTarget?: string } = {}): NodeJS.ProcessEnv {
	const { prepend, vars } = toolEnv(use, opts);
	const out: NodeJS.ProcessEnv = { ...env, ...vars };
	if (prepend.length) {
		const key = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
		out[key] = [...prepend, out[key] ?? ''].filter(Boolean).join(path.delimiter);
	}
	return out;
}

// 环境检查用：每样工具装没装
export function toolStatus(root = TOOLS_DIR): { name: string; ok: boolean; where: string }[] {
	const p = toolPaths(root);
	const exe = (dir: string, name: string) => ['.exe', '.cmd', ''].map((e) => path.join(dir, name + e)).find((f) => fs.existsSync(f));
	return [
		{ name: 'pnpm', ok: Boolean(exe(p.bin, 'pnpm')), where: p.bin },
		{ name: 'Rust（cargo）', ok: Boolean(exe(path.join(p.cargo, 'bin'), 'cargo')), where: path.join(p.cargo, 'bin') },
		{ name: 'Python', ok: Boolean(exe(p.python, 'python')), where: p.python },
	];
}
