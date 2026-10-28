// 把任务的改动带回你自己的仓库。两种方式：
// 1. 导出补丁：把一个任务的全部改动压成一个标准 git 补丁（含说明），在你的仓库里用 git am 应用
// 2. 推送：先取你仓库里目标分支的最新代码，在临时副本里应用这个补丁，再推到你仓库的一个新分支
//    dispatcher/task-<编号>。从不推到已有分支、从不强推、不碰你的工作目录；有冲突就不推
// 调度器里的项目副本可能和你的仓库没有共同历史（比如从备份重建的），所以统一按“补丁”来搬，不依赖历史
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { workPaths } from './config.ts';
import type { Store, Task } from './db.ts';
import { git, removeWorktree } from './git.ts';
import { run, timestampSlug } from './util.ts';

export type ExportInfo = {
	patch?: string;
	patchAt?: string;
	pushed?: { repo: string; branch: string; base: string; at: string };
};

export const exportInfo = (t: Task): ExportInfo => (t.export_info ? (JSON.parse(t.export_info) as ExportInfo) : {});

const ID = ['-c', 'user.name=AI 调度器', '-c', 'user.email=dispatcher@local'];
// 推送 / 拉取时不要停下来等终端输入密码（凭据由 Git 自己的凭据管理器处理）
const NET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

// 这个任务的改动 = 从哪个提交到哪棵树
function range(t: Task): { parent: string; tree: string } {
	if (t.status === 'merged' && t.merge_sha) return { parent: `${t.merge_sha}^1`, tree: `${t.merge_sha}^{tree}` };
	if (['passed', 'accepted'].includes(t.status) && t.branch && t.base_sha) return { parent: t.base_sha, tree: `${t.branch}^{tree}` };
	throw new Error('只有“待验收”“已接受”“已合并”的任务可以导出');
}

function message(t: Task): string {
	let review = '';
	try {
		const r = t.review ? JSON.parse(t.review) : null;
		if (r?.verdict === 'approve') review = `，${r.by} 复核通过`;
	} catch {}
	const spec = t.spec.length > 1500 ? `${t.spec.slice(0, 1500)}…` : t.spec;
	return `${t.title}\n\n${spec}\n\n由 AI 调度器任务 #${t.id} 生成（${t.agent} 完成${review}）。`;
}

// 压成一个提交（不挂在任何分支上，只用来生成补丁），返回它的编号
async function squash(cfg: Config, repo: string, t: Task): Promise<string> {
	const { parent, tree } = range(t);
	const diff = await run(cfg.git, ['-C', repo, 'diff', '--quiet', parent, tree], {});
	if (diff.code === 0) throw new Error('这个任务没有任何改动，不需要导出');
	const r = await run(cfg.git, [...ID, '-C', repo, 'commit-tree', tree, '-p', parent, '-F', '-'], { input: message(t) });
	if (r.code !== 0) throw new Error(`生成补丁失败：${(r.stderr || r.stdout).trim()}`);
	return r.stdout.trim();
}

function exportsDir(cfg: Config, project: string): string {
	const d = path.join(workPaths(cfg).root, 'exports', project);
	fs.mkdirSync(d, { recursive: true });
	return d;
}

function save(store: Store, t: Task, patch: Partial<ExportInfo>): void {
	store.updateTask(t.id, { export_info: JSON.stringify({ ...exportInfo(t), ...patch }) });
}

async function writePatch(cfg: Config, repo: string, t: Task, file: string): Promise<string> {
	const sha = await squash(cfg, repo, t);
	// 让 git 直接写文件：经过输出捕获的话，大补丁会被截断
	await git(cfg.git, repo, ['format-patch', '-1', '--binary', `--output=${file}`, sha]);
	return file;
}

export async function exportPatch(cfg: Config, store: Store, id: number): Promise<{ file: string; message: string }> {
	const t = store.getTask(id);
	if (!t) throw new Error(`找不到任务 #${id}`);
	const p = cfg.projects[t.project];
	if (!p) throw new Error(`未知项目 ${t.project}`);
	const file = await writePatch(cfg, p.repo, t, path.join(exportsDir(cfg, t.project), `task-${String(t.id).padStart(4, '0')}.patch`));
	save(store, t, { patch: file, patchAt: new Date().toISOString() });
	store.addEvent(t.id, null, 'info', 'export', `已导出补丁 ${file}`);
	return { file, message: `已导出补丁：${file}\n在你的仓库里运行：git am "${file}"` };
}

// 大任务：按顺序把每个已合并的子任务各导出一个补丁，放进同一个文件夹，依次 git am 即可
export async function exportPlan(cfg: Config, store: Store, id: number): Promise<{ dir: string; message: string }> {
	const t = store.getTask(id);
	if (!t || t.kind !== 'plan') throw new Error('只有大任务可以批量导出');
	const p = cfg.projects[t.project];
	if (!p) throw new Error(`未知项目 ${t.project}`);
	// 按合并的先后顺序（合并提交在基线分支上的顺序）排，保证依次应用不冲突
	const kids = store.childrenOf(t.id).filter((k) => k.status === 'merged' && k.merge_sha);
	if (!kids.length) throw new Error('还没有已合并的子任务');
	const order = (await git(cfg.git, p.repo, ['rev-list', '--first-parent', '--reverse', p.baseBranch])).split('\n').filter(Boolean);
	kids.sort((a, b) => order.indexOf(a.merge_sha!) - order.indexOf(b.merge_sha!));
	const dir = path.join(exportsDir(cfg, t.project), `plan-${String(t.id).padStart(4, '0')}`);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	for (const [i, k] of kids.entries()) {
		const file = await writePatch(cfg, p.repo, k, path.join(dir, `${String(i + 1).padStart(2, '0')}-task-${k.id}.patch`));
		save(store, k, { patch: file, patchAt: new Date().toISOString() });
	}
	save(store, t, { patch: dir, patchAt: new Date().toISOString() });
	store.addEvent(t.id, null, 'info', 'export', `已导出 ${kids.length} 个子任务的补丁到 ${dir}`);
	return { dir, message: `已导出 ${kids.length} 个补丁：${dir}\n在你的仓库里按文件名顺序运行：git am "${dir}\\*.patch"` };
}

export type PushOutcome = { ok: boolean; message: string; branch?: string; conflicts?: string[] };

export async function pushToUpstream(cfg: Config, store: Store, id: number): Promise<PushOutcome> {
	const t = store.getTask(id);
	if (!t) throw new Error(`找不到任务 #${id}`);
	const p = cfg.projects[t.project];
	if (!p) throw new Error(`未知项目 ${t.project}`);
	const up = p.upstream;
	if (!up?.repo) throw new Error('这个项目还没有设置“同步目标”（你的仓库），请在“设置 → 项目”里填写');
	const { file } = await exportPatch(cfg, store, id);
	const tracking = `refs/dispatcher/upstream/${up.branch}`;
	const f = await run(cfg.git, ['-C', p.repo, 'fetch', '--no-tags', up.repo, `+refs/heads/${up.branch}:${tracking}`], { env: NET_ENV, timeoutMs: 300_000 });
	if (f.code !== 0) return { ok: false, message: `读取你仓库的 ${up.branch} 分支失败，没有推送：${(f.stderr || f.stdout).trim().slice(0, 300)}` };
	const tmp = path.join(workPaths(cfg).worktrees, `_push-${t.id}-${timestampSlug()}`);
	await git(cfg.git, p.repo, ['worktree', 'add', '--detach', tmp, tracking]);
	try {
		const am = await run(cfg.git, [...ID, '-c', 'core.quotepath=false', 'am', '--3way', file], { cwd: tmp, timeoutMs: 120_000 });
		if (am.code !== 0) {
			const conflicts = (await run(cfg.git, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U'], { cwd: tmp })).stdout.split('\n').filter(Boolean);
			await run(cfg.git, ['am', '--abort'], { cwd: tmp });
			const msg = conflicts.length
				? `和你仓库 ${up.branch} 分支的最新代码有冲突（${conflicts.join('、')}），没有推送。可以先把补丁导出来自己处理`
				: `补丁在你仓库的最新代码上应用不了，没有推送：${(am.stderr || am.stdout).trim().slice(0, 300)}`;
			store.addEvent(t.id, null, 'warn', 'push', msg);
			return { ok: false, message: msg, conflicts };
		}
		// 只推新分支：同名分支已存在就加时间后缀，绝不覆盖
		let branch = `dispatcher/task-${t.id}`;
		const exists = await run(cfg.git, ['ls-remote', '--heads', up.repo, `refs/heads/${branch}`], { cwd: tmp, env: NET_ENV, timeoutMs: 120_000 });
		if (exists.stdout.trim()) branch = `${branch}-${timestampSlug()}`;
		const push = await run(cfg.git, ['push', up.repo, `HEAD:refs/heads/${branch}`], { cwd: tmp, env: NET_ENV, timeoutMs: 300_000 });
		if (push.code !== 0) {
			const msg = `推送失败：${(push.stderr || push.stdout).trim().slice(0, 300)}`;
			store.addEvent(t.id, null, 'warn', 'push', msg);
			return { ok: false, message: msg };
		}
		save(store, store.getTask(t.id)!, { pushed: { repo: up.repo, branch, base: up.branch, at: new Date().toISOString() } });
		const msg = `已推送到你的仓库（${up.repo}）的新分支 ${branch}，基于它的 ${up.branch}。检查后在你的仓库里合并：git merge ${branch}`;
		store.addEvent(t.id, null, 'info', 'push', msg);
		return { ok: true, message: msg, branch };
	} finally {
		await removeWorktree(cfg.git, p.repo, tmp).catch(() => {});
	}
}
