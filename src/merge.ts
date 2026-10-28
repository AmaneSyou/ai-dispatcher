// 把任务分支合并进你的项目。全程不碰你正在用的工作目录，直到最后一步：
// 1. 在临时副本里从基线分支最新提交开始合并（冲突就放弃，项目不受影响）
// 2. 在临时副本里重新跑项目的验收命令（没通过就放弃）
// 3. 都通过后才更新基线分支：你检出的正是基线分支时，要求没有未提交改动，并且只做快进；否则直接移动分支指针
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { workPaths } from './config.ts';
import type { Store, Task } from './db.ts';
import { formatReport, runCommands } from './gates.ts';
import { git, removeWorktree } from './git.ts';
import { syncParent } from './plan.ts';
import { run, timestampSlug } from './util.ts';

export type MergeOutcome = { ok: boolean; message: string; conflicts?: string[] };

async function tempWorktree(cfg: Config, repo: string, ref: string, label: string): Promise<string> {
	const dir = path.join(workPaths(cfg).worktrees, `_merge-${label}-${timestampSlug()}`);
	await git(cfg.git, repo, ['worktree', 'prune']);
	await git(cfg.git, repo, ['worktree', 'add', '--detach', dir, ref]);
	return dir;
}

async function dropTemp(cfg: Config, repo: string, dir: string): Promise<void> {
	await removeWorktree(cfg.git, repo, dir).catch(() => {});
}

// 把基线分支移到 newSha。你正检出基线分支时：只允许在干净工作区上快进，绝不覆盖你的未提交改动
async function advanceBase(cfg: Config, repo: string, base: string, oldSha: string, newSha: string): Promise<void> {
	const head = await run(cfg.git, ['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {});
	if (head.code === 0 && head.stdout.trim() === base) {
		const dirty = (await git(cfg.git, repo, ['status', '--porcelain', '--untracked-files=no'])).trim();
		if (dirty) throw new Error(`你的项目（${repo}）里有未提交的改动，为了不覆盖它们，这次没有更新。请先提交或暂存，再点一次合并`);
		await git(cfg.git, repo, ['merge', '--ff-only', newSha]);
		return;
	}
	// 没检出基线分支：直接移动分支指针；oldSha 做并发保护，期间分支被别人动过就失败
	await git(cfg.git, repo, ['update-ref', `refs/heads/${base}`, newSha, oldSha]);
}

// 合并和撤销排队一个个来：几个子任务同时通过并自动合并时，不会抢着移动同一个分支
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => {});
	return next;
}

export function mergeTask(cfg: Config, store: Store, id: number): Promise<MergeOutcome> {
	return serial(() => doMerge(cfg, store, id));
}

export function undoMerge(cfg: Config, store: Store, id: number): Promise<MergeOutcome> {
	return serial(() => doUndo(cfg, store, id));
}

async function doMerge(cfg: Config, store: Store, id: number): Promise<MergeOutcome> {
	const t = store.getTask(id);
	if (!t) throw new Error(`找不到任务 #${id}`);
	if (!['passed', 'accepted'].includes(t.status)) throw new Error('只有“待验收”或“已接受”的任务可以合并');
	if (!t.branch) throw new Error('这个任务没有分支，无法合并');
	const p = cfg.projects[t.project];
	if (!p) throw new Error(`未知项目 ${t.project}`);

	const baseSha = (await git(cfg.git, p.repo, ['rev-parse', '--verify', `${p.baseBranch}^{commit}`])).trim();
	const tmp = await tempWorktree(cfg, p.repo, baseSha, String(t.id));
	try {
		const m = await run(cfg.git, ['-c', 'core.quotepath=false', 'merge', '--no-ff', '--no-edit', '-m', `合并任务 #${t.id}：${t.title}`, t.branch], { cwd: tmp, timeoutMs: 120_000 });
		if (m.code !== 0) {
			const conflicts = (await run(cfg.git, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U'], { cwd: tmp })).stdout.split('\n').filter(Boolean);
			await run(cfg.git, ['merge', '--abort'], { cwd: tmp });
			const msg = conflicts.length
				? `和项目里的最新代码有冲突（${conflicts.join('、')}），项目没有被改动。可以让 AI 在最新代码上重做`
				: `合并失败，项目没有被改动：${(m.stderr || m.stdout).trim().slice(0, 300)}`;
			store.updateTask(t.id, { reason: msg });
			store.addEvent(t.id, null, 'warn', 'merge', msg);
			return { ok: false, message: msg, conflicts };
		}
		// 合并后的整体结果再验一次：两个各自通过的改动放在一起不一定还能通过。临时副本里同样先跑准备命令
		const cargoTarget = workPaths(cfg).cargoTarget;
		const prep = p.setup?.length ? await runCommands(p.setup, tmp, { cargoTarget, stopOnFail: true }) : [];
		const results = prep.some((r) => !r.ok) ? prep : await runCommands(p.gates, tmp, { cargoTarget });
		if (results.some((r) => !r.ok)) {
			const report = formatReport({ ok: false, changed: [], lines: 0, results, warnings: [] });
			const msg = '合并后的整体检查没通过，项目没有被改动';
			store.updateTask(t.id, { reason: msg, last_report: report });
			store.addEvent(t.id, null, 'warn', 'merge', `${msg}\n${report}`);
			return { ok: false, message: `${msg}。可以让 AI 在最新代码上重做` };
		}
		const mergeSha = (await git(cfg.git, tmp, ['rev-parse', 'HEAD'])).trim();
		await advanceBase(cfg, p.repo, p.baseBranch, baseSha, mergeSha);
		if (t.worktree && fs.existsSync(t.worktree)) await dropTemp(cfg, p.repo, t.worktree);
		store.updateTask(t.id, { status: 'merged', merge_sha: mergeSha, worktree: null, reason: null });
		store.addEvent(t.id, null, 'info', 'merged', `已合并进 ${p.baseBranch}（提交 ${mergeSha.slice(0, 8)}），合并后检查通过`);
		syncParent(store, t.parent_id);
		return { ok: true, message: `#${t.id} 已合并进项目的 ${p.baseBranch} 分支，合并后检查通过` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		store.updateTask(t.id, { reason: msg });
		store.addEvent(t.id, null, 'warn', 'merge', msg);
		return { ok: false, message: msg };
	} finally {
		await dropTemp(cfg, p.repo, tmp);
	}
}

// 撤销合并：新增一个“反向提交”抵消那次合并，历史完整保留，不丢任何东西
async function doUndo(cfg: Config, store: Store, id: number): Promise<MergeOutcome> {
	const t = store.getTask(id);
	if (!t) throw new Error(`找不到任务 #${id}`);
	if (t.status !== 'merged' || !t.merge_sha) throw new Error('这个任务没有处于“已合并”状态');
	const p = cfg.projects[t.project];
	if (!p) throw new Error(`未知项目 ${t.project}`);
	const baseSha = (await git(cfg.git, p.repo, ['rev-parse', '--verify', `${p.baseBranch}^{commit}`])).trim();
	const tmp = await tempWorktree(cfg, p.repo, baseSha, `undo-${t.id}`);
	try {
		const r = await run(cfg.git, ['revert', '--no-edit', '-m', '1', t.merge_sha], { cwd: tmp, timeoutMs: 120_000 });
		if (r.code !== 0) {
			await run(cfg.git, ['revert', '--abort'], { cwd: tmp });
			const msg = '这次合并之后项目又有了别的改动，自动撤销会冲突，项目没有被改动。需要你手动处理';
			store.addEvent(t.id, null, 'warn', 'unmerge', msg);
			return { ok: false, message: msg };
		}
		const revertSha = (await git(cfg.git, tmp, ['rev-parse', 'HEAD'])).trim();
		await advanceBase(cfg, p.repo, p.baseBranch, baseSha, revertSha);
		store.updateTask(t.id, { status: 'accepted', merge_sha: null, reason: '你撤销了合并' });
		store.addEvent(t.id, null, 'info', 'unmerge', `已撤销合并（反向提交 ${revertSha.slice(0, 8)}），分支 ${t.branch} 仍保留`);
		syncParent(store, t.parent_id);
		return { ok: true, message: `已撤销 #${t.id} 的合并` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		store.addEvent(t.id, null, 'warn', 'unmerge', msg);
		return { ok: false, message: msg };
	} finally {
		await dropTemp(cfg, p.repo, tmp);
	}
}

// 冲突或合并后检查失败：在项目最新代码上从头重做，把原因交给 AI
export function redoOnLatest(t: Task): string {
	return `上一版和项目里的最新代码合并时出了问题（${t.reason ?? '冲突或检查失败'}）。请基于当前最新的代码重新完成这个任务。`;
}
