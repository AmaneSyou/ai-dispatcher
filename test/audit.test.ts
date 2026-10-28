import assert from 'node:assert/strict';
import test from 'node:test';
import { auditShellCommand, auditToolCall } from '../src/audit.ts';
import type { AuditContext } from '../src/audit.ts';

const ctx: AuditContext = {
	worktree: 'G:\\AgentWork\\wt\\demo-1',
	sensitive: ['C:\\Users\\user\\.codex', 'G:\\AgentWork\\secrets'],
	allowedRead: ['G:\\AgentWork\\dsh-home\\task-1'],
};

test('工作区内的读写放行', () => {
	assert.equal(auditToolCall('write', { file_path: 'G:\\AgentWork\\wt\\demo-1\\src\\a.js', content: 'x' }, ctx).level, 'ok');
	assert.equal(auditToolCall('write', { file_path: 'src/a.js' }, ctx).level, 'ok');
	assert.equal(auditToolCall('pwsh', { command: 'node --test', workdir: 'G:\\AgentWork\\wt\\demo-1' }, ctx).level, 'ok');
});

test('写到工作区外直接终止，读只警告', () => {
	assert.equal(auditToolCall('write', { file_path: 'C:\\Users\\user\\outside.txt' }, ctx).level, 'block');
	assert.equal(auditToolCall('write', { file_path: '..\\outside.txt' }, ctx).level, 'block');
	assert.equal(auditToolCall('read', { file_path: 'C:\\Users\\user\\notes.txt' }, ctx).level, 'warn');
});

test('读敏感目录直接终止', () => {
	assert.equal(auditToolCall('read', { file_path: 'C:\\Users\\user\\.codex\\auth.json' }, ctx).level, 'block');
	assert.equal(auditToolCall('read', { file_path: 'G:\\AgentWork\\secrets\\deepseek.key' }, ctx).level, 'block');
	assert.equal(auditToolCall('read', { file_path: 'G:\\AgentWork\\dsh-home\\task-1\\x.json' }, ctx).level, 'ok');
});

test('申请提权单独标记', () => {
	const v = auditToolCall('write', { file_path: '..\\x', sandbox_permissions: 'danger-full-access', justification: '需要' }, ctx);
	assert.equal(v.level, 'escalation');
});

test('shell 命令', () => {
	assert.equal(auditShellCommand('Get-Content $env:USERPROFILE\\.codex\\auth.json', ctx).level, 'block');
	assert.equal(auditShellCommand('git push origin main', ctx).level, 'block');
	assert.equal(auditShellCommand('git -c user.name=x commit -m hi', ctx).level, 'block');
	assert.equal(auditShellCommand('git status', ctx).level, 'ok');
	assert.equal(auditShellCommand('Set-Content D:\\other\\x.txt hi', ctx).level, 'block');
	assert.equal(auditShellCommand('Get-ChildItem D:\\other', ctx).level, 'warn');
	// 调用 Program Files 下的程序并重定向到工作区内，不应误杀
	assert.equal(auditShellCommand('& "C:\\Program Files\\nodejs\\node.exe" --test > out.txt', ctx).level, 'ok');
	assert.equal(auditShellCommand('Get-ChildItem D:\\other 2>$null', ctx).level, 'warn');
});
