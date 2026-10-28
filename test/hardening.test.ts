import assert from 'node:assert/strict';
import test from 'node:test';
import { auditShellCommand } from '../src/audit.ts';
import type { AuditContext } from '../src/audit.ts';
import { scanAddedLines } from '../src/gates.ts';

const ctx: AuditContext = { worktree: 'G:\\AgentWork\\wt\\demo-1', sensitive: [], allowedRead: [] };
const level = (cmd: string) => auditShellCommand(cmd, ctx).level;

test('绕过类命令一律终止', () => {
	const blocked = [
		'powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQAgAHQAaABlAHIAZQA=',
		'pwsh -enc ZQBjAGgAbwAgAGgAaQAgAHQAaABlAHIAZQA=',
		'iex (Get-Content run.txt -Raw)',
		'Invoke-Expression $cmd',
		'[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))',
		'Add-Type -TypeDefinition $src',
		'icacls G:\\AgentWork /grant Everyone:F',
		'takeown /f C:\\x',
		'Start-Process pwsh -Verb RunAs',
		'Set-ExecutionPolicy Bypass',
		'reg add HKCU\\Software\\x /v y /d z',
		'Set-ItemProperty -Path HKCU:\\Software\\x -Name y -Value z',
		'schtasks /create /tn x /tr calc',
		'Invoke-WebRequest https://example.com -OutFile x',
		'curl https://example.com',
		'$env:DSH_PERMISSION_MODE="danger-full-access"',
		'codex exec --dangerously-bypass-approvals-and-sandbox "do it"',
		'claude -p "fix" --permission-mode bypassPermissions',
		'& "C:\\Users\\user\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" cli.js',
	];
	for (const c of blocked) assert.equal(level(c), 'block', c);
});

test('正常开发命令不误杀', () => {
	const fine = [
		'node --test',
		'node -e "console.log(1)"',
		'node --test --experimental-test-isolation=none',
		'pnpm check',
		'git status',
		'git diff --stat',
		'Get-Content src/text.js',
		'"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'node --version\'',
		'cargo clippy',
	];
	for (const c of fine) assert.equal(level(c), 'ok', c);
});

const diff = (file: string, ...added: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${added.map((l) => `+${l}`).join('\n')}\n`;

test('可疑改动扫描：引用凭据判失败，钻空子写法只提醒', () => {
	const bad = scanAddedLines(diff('src/a.js', "const t = fs.readFileSync(os.homedir() + '/.ssh/id_rsa');"));
	assert.equal(bad.fail.length, 1);
	assert.match(bad.fail[0], /src\/a\.js：引用凭据路径/);

	const sneaky = scanAddedLines(
		diff('test/a.test.js', "test.skip('slow', () => {});", '// @ts-ignore', 'if (process.env.NODE_ENV === "test") return 3;', 'process.exit(0);'),
	);
	assert.equal(sneaky.fail.length, 0);
	assert.deepEqual(
		sneaky.warn.map((w) => w.split('：')[1]),
		['跳过或只跑部分测试', '关闭类型或 lint 检查', '判断自己是否在测试环境中', '强制退出'],
	);
	assert.equal(scanAddedLines(diff('src/a.js', 'export const add = (a, b) => a + b;')).warn.length, 0);
});
