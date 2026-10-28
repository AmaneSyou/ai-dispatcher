import type { GateCmd } from './config.ts';
import { changedFiles, changedLines, git, stageAll } from './git.ts';
import { matchAny } from './glob.ts';
import { withTools } from './tools.ts';
import { run, tail } from './util.ts';

export type GateResult = { name: string; ok: boolean; detail: string };
// warnings：不判失败，但要提醒人重点看的改动
export type GateReport = { ok: boolean; changed: string[]; lines: number; results: GateResult[]; warnings: string[] };

// 针对“为了让检查通过而钻空子”的典型写法，只扫描新增的行。
// 引用凭据路径直接判失败（而且不再执行验收命令，免得运行这段代码）；其余只提醒，因为正常项目里也可能出现
const SCAN_FAIL: { re: RegExp; label: string }[] = [
	{ re: /\.codex[\\/]|\.claude[\\/]|\.ssh[\\/]|auth\.json|\.git-credentials|deepseek\.key|\.credentials\.json/i, label: '引用凭据路径' },
];
const SCAN_WARN: { re: RegExp; label: string }[] = [
	{ re: /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\bx(?:it|describe)\(|@Ignore\b|#\[ignore\]|pytest\.mark\.skip|\bskip\s*:\s*true/i, label: '跳过或只跑部分测试' },
	{ re: /process\.exit\(\s*0?\s*\)|\bos\._exit\(|\bsys\.exit\(\s*0\s*\)/, label: '强制退出' },
	{ re: /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|biome-ignore|#\[allow\(|#\s*noqa|type:\s*ignore/i, label: '关闭类型或 lint 检查' },
	{ re: /NODE_TEST_CONTEXT|process\.env\.(?:CI|NODE_ENV)\b|JEST_WORKER_ID|VITEST\b/, label: '判断自己是否在测试环境中' },
	{ re: /danger-full-access|--dangerously|sandbox_permissions|DSH_PERMISSION_MODE/i, label: '涉及沙盒或权限开关' },
	{ re: /child_process|\bexecSync\b|\bspawnSync?\(|\bsubprocess\b|\bos\.system\(|Start-Process/i, label: '在代码里启动外部程序' },
];

export function scanAddedLines(diff: string): { fail: string[]; warn: string[] } {
	const fail: string[] = [];
	const warn: string[] = [];
	let file = '';
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) {
			file = line.slice(4).replace(/^b\//, '');
			continue;
		}
		if (!line.startsWith('+') || line.startsWith('+++')) continue;
		const text = line.slice(1).trim();
		const hit = (label: string) => `${file}：${label}：${text.slice(0, 100)}`;
		for (const r of SCAN_FAIL) if (r.re.test(text)) fail.push(hit(r.label));
		for (const r of SCAN_WARN) if (r.re.test(text)) warn.push(hit(r.label));
	}
	return { fail: fail.slice(0, 20), warn: warn.slice(0, 20) };
}

export type GateInput = {
	git: string;
	worktree: string;
	baseSha: string;
	allow: string[];
	readonly: string[];
	protectedGlobs: string[];
	maxFiles: number;
	maxLines: number;
	commands: GateCmd[];
	// 各副本共用的 Rust 编译缓存目录
	cargoTarget?: string;
};

// 纯路径规则，单独导出便于测试
export function checkPaths(
	changed: string[],
	rules: { allow: string[]; readonly: string[]; protectedGlobs: string[] },
): GateResult[] {
	const results: GateResult[] = [];
	const prot = changed.filter((f) => matchAny(f, rules.protectedGlobs));
	results.push({
		name: '受保护文件',
		ok: prot.length === 0,
		detail: prot.length ? `改动了受保护文件：${prot.join(', ')}` : '未触碰',
	});
	const ro = changed.filter((f) => matchAny(f, rules.readonly));
	results.push({
		name: '只读文件',
		ok: ro.length === 0,
		detail: ro.length ? `改动了本任务只读的文件（通常是测试）：${ro.join(', ')}` : '未触碰',
	});
	if (rules.allow.length > 0) {
		const outside = changed.filter((f) => !matchAny(f, rules.allow));
		results.push({
			name: '允许范围',
			ok: outside.length === 0,
			detail: outside.length ? `超出允许修改范围：${outside.join(', ')}` : '全部在范围内',
		});
	}
	return results;
}

// 验收会执行 worker 改过的代码，而且不在沙盒里，所以不给它任何像凭据的环境变量。
// NODE_TEST_CONTEXT 会让嵌套的 node --test 把结果汇报给外层进程，退出码失真
const SECRET_ENV = /token|secret|password|passwd|api_?key|credential/i;

export function gateEnv(opts: { cargoTarget?: string } = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k === 'NODE_TEST_CONTEXT' || SECRET_ENV.test(k)) continue;
		env[k] = v;
	}
	// 装在调度器 tools 目录里的 pnpm、Rust 等
	return withTools(env, 'gate', { cargoTarget: opts.cargoTarget });
}

export async function runGates(input: GateInput): Promise<GateReport> {
	await stageAll(input.git, input.worktree);
	const changed = await changedFiles(input.git, input.worktree, input.baseSha);
	const lines = await changedLines(input.git, input.worktree, input.baseSha);
	const results: GateResult[] = [];

	results.push({ name: '有改动', ok: changed.length > 0, detail: changed.length ? `${changed.length} 个文件` : '没有任何改动' });
	results.push(...checkPaths(changed, input));
	results.push({
		name: '改动规模',
		ok: changed.length <= input.maxFiles && lines <= input.maxLines,
		detail: `${changed.length} 个文件 / ${lines} 行（上限 ${input.maxFiles} / ${input.maxLines}）`,
	});
	const diff = await git(input.git, input.worktree, ['diff', '--cached', '--no-renames', '-U0', input.baseSha]);
	const scan = scanAddedLines(diff);
	results.push({
		name: '可疑改动扫描',
		ok: scan.fail.length === 0,
		detail: scan.fail.length
			? `发现必须拦下的改动：\n${scan.fail.join('\n')}`
			: scan.warn.length
				? `${scan.warn.length} 处需要你重点看（不判失败）`
				: '未发现',
	});

	// 路径不合规就不再跑命令：省时间，也避免执行越界改动里的代码
	const pathsOk = results.every((r) => r.ok);
	if (pathsOk) results.push(...(await runCommands(input.commands, input.worktree, { cargoTarget: input.cargoTarget })));
	else for (const g of input.commands) results.push({ name: g.name, ok: false, detail: '已跳过（前面的检查未通过）' });

	return { ok: results.every((r) => r.ok), changed, lines, results, warnings: scan.warn };
}

// 只跑项目的验收命令（合并后在临时副本里复检也用它）
// 准备命令也用它：stopOnFail 时前一条失败就不跑后面的（装依赖失败后再跑别的没意义）
export async function runCommands(commands: GateCmd[], cwd: string, opts: { cargoTarget?: string; stopOnFail?: boolean } = {}): Promise<GateResult[]> {
	const results: GateResult[] = [];
	for (const g of commands) {
		if (opts.stopOnFail && results.some((x) => !x.ok)) {
			results.push({ name: g.name, ok: false, detail: '已跳过（前面的命令失败）' });
			continue;
		}
		const r = await run(`chcp 65001 >nul && ${g.cmd}`, [], {
			cwd,
			env: gateEnv({ cargoTarget: opts.cargoTarget }),
			shell: true,
			timeoutMs: (g.timeoutMinutes ?? 10) * 60_000,
		});
		const out = tail(`${r.stdout}\n${r.stderr}`.trim(), 4000);
		results.push({
			name: g.name,
			ok: r.code === 0 && !r.timedOut,
			detail: r.timedOut ? `超时\n${out}` : `退出码 ${r.code}\n${out}`,
		});
	}
	return results;
}

export function formatReport(report: GateReport): string {
	const main = report.results.map((r) => `${r.ok ? '✔' : '✘'} ${r.name}：${r.detail}`).join('\n');
	return report.warnings.length ? `${main}\n\n⚠ 需要重点看的改动：\n${report.warnings.join('\n')}` : main;
}
