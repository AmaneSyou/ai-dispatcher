// 整理已经结束的任务，省磁盘：日志压缩成 .gz 留档（汇报、用量都在数据库里，不受影响），
// DSH 会话目录删掉（只有接着原会话重试时才用得上；没了也会自动换新会话），残留的工作区和临时合并目录清掉
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Config } from './config.ts';
import { workPaths } from './config.ts';
import type { Store, Task } from './db.ts';
import { git, removeWorktree } from './git.ts';

const DAY = 86_400_000;
// 合并、接受就算整个任务完成，马上整理；取消和驳回的可能还会重试，等几天没动静再整理
const DONE = ['merged', 'accepted'];
const MAYBE_RETRIED = ['cancelled', 'rejected'];
export const RETRY_GRACE_DAYS = 7;

function sizeOf(p: string): number {
	if (!fs.existsSync(p)) return 0;
	const st = fs.statSync(p);
	if (!st.isDirectory()) return st.size;
	return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
}

function due(t: Task, now: number): boolean {
	if (t.tidied) return false;
	if (DONE.includes(t.status)) return true;
	// 大任务：子任务还在跑时不算结束
	if (t.status === 'split') return false;
	return MAYBE_RETRIED.includes(t.status) && now - Date.parse(t.updated_at) > RETRY_GRACE_DAYS * DAY;
}

export async function tidyTask(cfg: Config, store: Store, t: Task): Promise<number> {
	let freed = 0;
	for (const a of store.attemptsFor(t.id)) {
		if (!a.log_path || a.log_path.endsWith('.gz') || !fs.existsSync(a.log_path)) continue;
		const raw = fs.readFileSync(a.log_path);
		const gz = `${a.log_path}.gz`;
		fs.writeFileSync(gz, zlib.gzipSync(raw, { level: 9 }));
		fs.rmSync(a.log_path);
		store.setAttemptLog(a.id, gz);
		freed += raw.length - fs.statSync(gz).size;
	}
	// 只删调度器自己建在 dsh-home 下的目录，别的路径一律不碰
	const home = t.dsh_home;
	if (home && path.resolve(home).startsWith(path.resolve(workPaths(cfg).dshHome) + path.sep) && fs.existsSync(home)) {
		freed += sizeOf(home);
		fs.rmSync(home, { recursive: true, force: true });
	}
	// 运行中被取消的任务会留下工作区；分支保留，以后重试还能重建
	if (t.worktree && fs.existsSync(t.worktree)) {
		freed += sizeOf(t.worktree);
		const repo = cfg.projects[t.project]?.repo;
		if (repo) await removeWorktree(cfg.git, repo, t.worktree).catch(() => {});
		fs.rmSync(t.worktree, { recursive: true, force: true });
		store.updateTask(t.id, { worktree: null, last_worktree: t.worktree });
	}
	store.updateTask(t.id, { tidied: 1 });
	return freed;
}

// 定期跑一次。返回整理了几个任务、省下多少字节
export async function tidyEnded(cfg: Config, store: Store, now = Date.now()): Promise<{ tasks: number; freed: number }> {
	let tasks = 0;
	let freed = 0;
	for (const t of store.listTasks(100_000, true)) {
		if (!due(t, now)) continue;
		try {
			freed += await tidyTask(cfg, store, t);
			tasks++;
		} catch (e) {
			store.addEvent(t.id, null, 'warn', 'tidy', `整理失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
	// 调度器在合并或判断难度中途被关掉时，临时目录会留下；超过一小时的清掉
	const wt = workPaths(cfg).worktrees;
	if (fs.existsSync(wt)) {
		for (const d of fs.readdirSync(wt)) {
			const p = path.join(wt, d);
			if ((d.startsWith('_merge-') || d.startsWith('_triage-')) && now - fs.statSync(p).mtimeMs > 3_600_000) {
				freed += sizeOf(p);
				fs.rmSync(p, { recursive: true, force: true });
			}
		}
		for (const p of Object.values(cfg.projects)) await git(cfg.git, p.repo, ['worktree', 'prune']).catch(() => '');
	}
	if (tasks) store.addEvent(null, null, 'info', 'tidy', `整理了 ${tasks} 个已结束的任务：日志压缩存档、删除 DSH 会话目录，省下约 ${(freed / 1048576).toFixed(1)} MB`);
	return { tasks, freed };
}
