import fs from 'node:fs';
import { run } from './util.ts';

export async function git(gitBin: string, cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
	const r = await run(gitBin, ['-c', 'core.quotepath=false', ...args], { cwd, timeoutMs });
	if (r.code !== 0) {
		throw new Error(`git ${args.join(' ')} 失败（${r.code}）：${(r.stderr || r.stdout).trim()}`);
	}
	return r.stdout;
}

// 从基线分支的当前提交拉一个新分支和独立目录，worker 只在这个目录里干活
export async function createWorktree(gitBin: string, repo: string, baseBranch: string, dir: string, branch: string): Promise<string> {
	const sha = (await git(gitBin, repo, ['rev-parse', '--verify', `${baseBranch}^{commit}`])).trim();
	await git(gitBin, repo, ['worktree', 'add', '-b', branch, dir, sha]);
	return sha;
}

// 驳回后重试：把任务原来的分支重新检出到新目录，AI 能接着上一版改，而不是从零开始
export async function attachWorktree(gitBin: string, repo: string, dir: string, branch: string): Promise<void> {
	await git(gitBin, repo, ['worktree', 'prune']);
	await git(gitBin, repo, ['worktree', 'add', dir, branch]);
}

export async function branchExists(gitBin: string, repo: string, branch: string): Promise<boolean> {
	try {
		await git(gitBin, repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

export async function headSha(gitBin: string, wt: string): Promise<string> {
	return (await git(gitBin, wt, ['rev-parse', 'HEAD'])).trim();
}

// 工作区（含未提交的改动）和某个提交相比有没有不同
export async function changedSince(gitBin: string, wt: string, sha: string): Promise<boolean> {
	await stageAll(gitBin, wt);
	const out = await git(gitBin, wt, ['diff', '--cached', '--no-renames', '--name-only', sha]);
	return out.trim().length > 0;
}

export async function stageAll(gitBin: string, wt: string): Promise<void> {
	await git(gitBin, wt, ['add', '-A']);
}

export async function changedFiles(gitBin: string, wt: string, baseSha: string): Promise<string[]> {
	const out = await git(gitBin, wt, ['diff', '--cached', '--no-renames', '--name-only', '-z', baseSha]);
	return out.split('\0').filter(Boolean);
}

export async function changedLines(gitBin: string, wt: string, baseSha: string): Promise<number> {
	const out = await git(gitBin, wt, ['diff', '--cached', '--no-renames', '--numstat', baseSha]);
	let total = 0;
	for (const line of out.split('\n')) {
		const [a, d] = line.split('\t');
		// 二进制文件显示为 "-"，按 0 计
		total += (Number(a) || 0) + (Number(d) || 0);
	}
	return total;
}

// worker 自己不能提交（沙盒挡住了主仓库的 .git），由调度器以 worker 身份代为提交
export async function commitAll(gitBin: string, wt: string, message: string, author: string): Promise<string | null> {
	await stageAll(gitBin, wt);
	const status = await git(gitBin, wt, ['status', '--porcelain']);
	if (!status.trim()) return null;
	await git(gitBin, wt, [
		'-c',
		`user.name=${author}`,
		'-c',
		'user.email=worker@dispatcher.local',
		'commit',
		'-m',
		message,
	]);
	return (await git(gitBin, wt, ['rev-parse', 'HEAD'])).trim();
}

// git 删副本时会留下被忽略的目录（实测 pnpm 装的 node_modules 留在原地，几百 MB），所以最后再把整个目录删干净
export async function removeWorktree(gitBin: string, repo: string, dir: string): Promise<void> {
	try {
		await git(gitBin, repo, ['worktree', 'remove', '--force', dir]);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		await git(gitBin, repo, ['worktree', 'prune']).catch(() => '');
	}
}
