import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export type RunOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	shell?: boolean;
	input?: string;
	maxOutputChars?: number;
};

// 子进程输出可能很大（测试日志、构建输出），只保留头尾，避免调度器内存被撑爆
function appendCapped(buf: string, chunk: string, cap: number): string {
	const next = buf + chunk;
	if (next.length <= cap) return next;
	const head = Math.floor(cap / 4);
	return `${next.slice(0, head)}\n…[中间省略]…\n${next.slice(next.length - (cap - head))}`;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
	const cap = opts.maxOutputChars ?? 200_000;
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			shell: opts.shell ?? false,
			windowsHide: true,
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (d: string) => {
			stdout = appendCapped(stdout, d, cap);
		});
		child.stderr.on('data', (d: string) => {
			stderr = appendCapped(stderr, d, cap);
		});
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killTree(child.pid);
				}, opts.timeoutMs)
			: null;
		child.on('error', (e) => {
			stderr += String(e);
		});
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
		child.stdin.on('error', () => {});
		child.stdin.end(opts.input ?? '');
	});
}

// Windows 上 kill() 只杀外层进程，子进程（pwsh、node 测试）会残留，必须整树结束
export function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
	} else {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {}
		}
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function localMidnightIso(): string {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.toISOString();
}

export function expandEnv(s: string): string {
	return s.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);
}

export function tail(s: string, n: number): string {
	return s.length <= n ? s : `…${s.slice(s.length - n)}`;
}

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function timestampSlug(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
