import path from 'node:path';
import { isInside } from './util.ts';

// 审计是沙盒之外的第二道防线：DSH 沙盒只限制写，不限制读，也不阻止它申请提权
export type AuditLevel = 'ok' | 'warn' | 'block' | 'escalation';
export type AuditVerdict = { level: AuditLevel; reason: string };

export type AuditContext = {
	worktree: string;
	sensitive: string[];
	// worker 自己的 DSH_HOME 等，读取属于正常行为
	allowedRead: string[];
};

const READ_ONLY_TOOLS = new Set([
	'read',
	'glob',
	'grep',
	'list',
	'ls',
	'search',
	'find',
	'view',
	'working_directory',
	'skill',
	'todo_write',
	'todo_read',
]);
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'powershell']);

const PATH_KEYS = /^(file_?path|notebook_?path|path|paths|dir|directory|workdir|cwd|target|source|destination|dest|from|to)$/i;

const RANK: Record<AuditLevel, number> = { ok: 0, warn: 1, block: 2, escalation: 3 };

function worst(vs: AuditVerdict[]): AuditVerdict {
	return vs.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a), { level: 'ok', reason: '' });
}

function collectPaths(input: unknown): string[] {
	const out: string[] = [];
	if (!input || typeof input !== 'object') return out;
	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		if (!PATH_KEYS.test(k)) continue;
		if (typeof v === 'string') out.push(v);
		else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
	}
	return out;
}

const SENSITIVE_MARKERS = [
	'.codex',
	'.claude',
	'.ssh',
	'.aws',
	'.git-credentials',
	'auth.json',
	'.credentials',
	'deepseek.key',
	'id_rsa',
	'id_ed25519',
];

const GIT_BLOCKED = /\bgit(?:\.exe)?\s+(?:-c\s+\S+\s+)*(push|remote|config|commit|worktree|update-ref|filter-branch|filter-repo)\b/i;

// 这些写法要么让审计看不懂命令内容，要么在改权限、改系统、联网、另起一个不受限的代理。
// 正常的编码任务用不到，出现就直接终止，宁可误杀交给人看
const BYPASS_RULES: { re: RegExp; reason: string }[] = [
	{ re: /\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, reason: '用编码命令隐藏真实内容（-EncodedCommand）' },
	{ re: /\b(?:invoke-expression|iex)\b/i, reason: '动态执行字符串命令（Invoke-Expression）' },
	{ re: /\badd-type\b/i, reason: '在命令里临时编译代码（Add-Type）' },
	{ re: /frombase64string/i, reason: '解码 Base64 内容' },
	{ re: /\b(?:icacls|cacls|takeown|set-acl)\b/i, reason: '修改文件权限或所有者' },
	{ re: /-verb\s+runas\b|\brunas(?:\.exe)?\s/i, reason: '以管理员或其他用户身份运行' },
	{ re: /\bset-executionpolicy\b/i, reason: '修改 PowerShell 执行策略' },
	{ re: /\breg(?:\.exe)?\s+(?:add|delete|import|load|copy|restore)\b|\b(?:set|new|remove)-itemproperty\b[^\n]*\bhk(?:lm|cu|cr|u)\b|\bhk(?:lm|cu):/i, reason: '修改注册表' },
	{ re: /\b(?:schtasks|register-scheduledtask|new-service|set-service)\b|\bsc(?:\.exe)?\s+(?:create|config|start|stop)\b/i, reason: '创建或修改计划任务 / 系统服务' },
	{ re: /\b(?:netsh|set-mppreference|add-mppreference|bcdedit|vssadmin)\b/i, reason: '修改网络、防病毒或系统启动配置' },
	{ re: /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer|curl|wget)\b|certutil[^\n]*-urlcache/i, reason: '联网下载或上传' },
	{ re: /danger-full-access|--dangerously|sandbox_permissions|dsh_permission_mode|bypasspermissions/i, reason: '试图关闭或绕过沙盒' },
	{ re: /\bcodex(?:\.exe)?\s+(?:exec|e)\b|\bclaude(?:\.exe)?\s+(?:-p|--print)\b|\bdsh(?:\.cmd)?\s+(?:--profile|headless)\b|deepseek harness\.exe/i, reason: '在 worker 里再启动一个 AI 代理（可能不受当前沙盒约束）' },
];
const WRITE_VERBS =
	/\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|expand-archive|rm|del|erase|rmdir|rd|mkdir|md|move|copy|xcopy|robocopy|ren)\b|>>?\s*(?!\$null\b|&\d|nul\b)/i;
const ABS_PATH = /[A-Za-z]:[\\/][^\s'"|;`<>]*/g;
// 命令里引用这些位置通常只是调用程序（node、git、pwsh），不算越界；带空格的路径会被截断，所以按前缀判断
const SYSTEM_PREFIXES = ['c:\\program', 'c:/program', 'c:\\windows', 'c:/windows'];

// 命令里提到了敏感目录，而且至少有一处不是在引用它里面被放行的子目录（例如调度器目录下的 tools）
// 每一处都按“解析后的完整路径”判断，防止用 tools\..\ 绕回调度器目录
function mentionsOutsideAllowed(lower: string, dir: string, allowed: string[]): boolean {
	const ok = allowed.filter((a) => isInside(a, dir) && path.resolve(a).toLowerCase() !== path.resolve(dir).toLowerCase());
	for (let i = lower.indexOf(dir); i >= 0; i = lower.indexOf(dir, i + 1)) {
		const token = lower.slice(i).match(/^[^\s"'|&;<>]+/)?.[0] ?? dir;
		if (!ok.some((a) => isInside(path.resolve(token), a))) return true;
	}
	return false;
}

export function auditShellCommand(rawCommand: string, ctx: AuditContext): AuditVerdict {
	// Codex 上报的命令里路径是双反斜杠（C:\\Windows\\...），不归一化会绕过下面的路径匹配
	const command = rawCommand.replace(/\\{2,}/g, '\\');
	const lower = command.toLowerCase();
	const verdicts: AuditVerdict[] = [];
	for (const s of ctx.sensitive) {
		if (mentionsOutsideAllowed(lower, s.toLowerCase(), ctx.allowedRead)) verdicts.push({ level: 'block', reason: `命令引用了敏感目录 ${s}` });
	}
	for (const m of SENSITIVE_MARKERS) {
		if (lower.includes(m)) verdicts.push({ level: 'block', reason: `命令引用了凭据相关路径（${m}）` });
	}
	const g = command.match(GIT_BLOCKED);
	if (g) verdicts.push({ level: 'block', reason: `worker 不允许执行 git ${g[1]}` });
	for (const rule of BYPASS_RULES) {
		if (rule.re.test(command)) verdicts.push({ level: 'block', reason: rule.reason });
	}

	const writes = WRITE_VERBS.test(command);
	for (const p of command.match(ABS_PATH) ?? []) {
		const clean = p.replace(/[),\]]+$/, '');
		if (SYSTEM_PREFIXES.some((s) => clean.toLowerCase().startsWith(s))) continue;
		if (isInside(clean, ctx.worktree) || ctx.allowedRead.some((a) => isInside(clean, a))) continue;
		verdicts.push(
			writes
				? { level: 'block', reason: `命令可能写入工作区以外的路径 ${clean}` }
				: { level: 'warn', reason: `命令引用了工作区以外的路径 ${clean}` },
		);
	}
	return worst(verdicts);
}

export function auditToolCall(tool: string, input: unknown, ctx: AuditContext): AuditVerdict {
	const verdicts: AuditVerdict[] = [];
	const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

	// DSH 碰到沙盒拒绝后会自己申请 danger-full-access；headless 下虽然会被拒，但这是需要人看的信号
	if (obj.sandbox_permissions !== undefined) {
		return { level: 'escalation', reason: `worker 申请提升权限：${String(obj.sandbox_permissions)}（理由：${String(obj.justification ?? '无')}）` };
	}

	const name = tool.toLowerCase();
	const readOnly = READ_ONLY_TOOLS.has(name);
	for (const raw of collectPaths(obj)) {
		const p = path.resolve(ctx.worktree, raw);
		if (ctx.sensitive.some((s) => isInside(p, s)) && !ctx.allowedRead.some((a) => isInside(p, a))) {
			verdicts.push({ level: 'block', reason: `${tool} 访问敏感路径 ${p}` });
			continue;
		}
		if (isInside(p, ctx.worktree) || ctx.allowedRead.some((a) => isInside(p, a))) continue;
		verdicts.push(
			readOnly
				? { level: 'warn', reason: `${tool} 读取工作区以外的路径 ${p}` }
				: { level: 'block', reason: `${tool} 操作工作区以外的路径 ${p}` },
		);
	}

	if (SHELL_TOOLS.has(name) && typeof obj.command === 'string') {
		verdicts.push(auditShellCommand(obj.command, ctx));
	}
	return worst(verdicts);
}
