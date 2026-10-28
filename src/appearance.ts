// 面板外观：背景图存在 workRoot\ui-assets，配置里只记文件名
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { appearanceOf, saveConfig, workPaths } from './config.ts';

export const MAX_BACKGROUND_BYTES = 15 * 1024 * 1024;

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const NAME = /^background-\d+\.(png|jpg|webp|gif)$/;

// 只看文件开头的“魔数”认格式，不信文件名和浏览器给的类型
export function detectImage(buf: Buffer): string | null {
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
	if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
	if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) return 'gif';
	return null;
}

export class AppearanceError extends Error {}

const pct = (v: unknown, min: number, max: number, name: string): number => {
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) throw new AppearanceError(`${name}必须是 ${min}～${max} 之间的整数`);
	return n;
};

export function applyAppearance(cfg: Config, body: { panelOpacity?: unknown; blur?: unknown; dim?: unknown }): void {
	const cur = appearanceOf(cfg);
	cfg.appearance = {
		...cur,
		panelOpacity: pct(body.panelOpacity ?? cur.panelOpacity, 30, 100, '面板不透明度'),
		blur: pct(body.blur ?? cur.blur, 0, 30, '毛玻璃模糊'),
		dim: pct(body.dim ?? cur.dim, 0, 90, '背景变暗'),
	};
	saveConfig(cfg);
}

// 背景图的完整路径；配置里的文件名不合规矩或文件不在了就当没有
export function backgroundPath(cfg: Config): string | null {
	const name = appearanceOf(cfg).background;
	if (!name || !NAME.test(name)) return null;
	const file = path.join(workPaths(cfg).uiAssets, name);
	return fs.existsSync(file) ? file : null;
}

export function backgroundType(file: string): string {
	return TYPES[path.extname(file).slice(1)] ?? 'application/octet-stream';
}

function dropOld(cfg: Config): void {
	const old = backgroundPath(cfg);
	if (old) fs.rmSync(old, { force: true });
}

export function saveBackground(cfg: Config, base64: string): string {
	const data = Buffer.from(String(base64 ?? '').replace(/^data:[^,]*,/, ''), 'base64');
	if (!data.length) throw new AppearanceError('没有收到图片');
	if (data.length > MAX_BACKGROUND_BYTES) throw new AppearanceError(`图片太大（${(data.length / 1048576).toFixed(1)} MB），最大 15 MB`);
	const ext = detectImage(data);
	if (!ext) throw new AppearanceError('只支持 PNG、JPG、WebP、GIF 图片');
	const dir = workPaths(cfg).uiAssets;
	fs.mkdirSync(dir, { recursive: true });
	// 每次换图用新文件名，面板不会拿到浏览器缓存里的旧图
	const name = `background-${Date.now()}.${ext}`;
	fs.writeFileSync(path.join(dir, name), data);
	dropOld(cfg);
	cfg.appearance = { ...appearanceOf(cfg), background: name };
	saveConfig(cfg);
	return name;
}

export function removeBackground(cfg: Config): void {
	dropOld(cfg);
	cfg.appearance = { ...appearanceOf(cfg), background: null };
	saveConfig(cfg);
}
