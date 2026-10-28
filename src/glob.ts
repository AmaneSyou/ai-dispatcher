// 只实现调度器需要的子集：** 跨目录、* 和 ? 不跨目录。Windows 路径不区分大小写
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
	const hit = cache.get(glob);
	if (hit) return hit;
	const g = glob.replace(/\\/g, '/');
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				i++;
				if (g[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]\\'.includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	const out = new RegExp(`^${re}$`, 'i');
	cache.set(glob, out);
	return out;
}

export function matchAny(file: string, globs: string[]): boolean {
	const f = file.replace(/\\/g, '/');
	return globs.some((g) => globToRegExp(g).test(f));
}
