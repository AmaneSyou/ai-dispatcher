// 生成 ui/favicon.ico：蓝紫渐变圆角方块上，一个发光的“调度中心”向右分出三条弧线，
// 连到三个彩色节点（代表三个 AI）。小尺寸单独加粗，托盘里也看得清。
// 不依赖任何图片库：自己算覆盖率做抗锯齿，写 BMP 格式的 ICO；同时输出一张预览 PNG。
// 运行：node scripts/make-icon.ts [预览图路径]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type RGBA = [number, number, number, number];
type Pt = [number, number];

const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// 超椭圆（比普通圆角更柔和的“方圆”）
function inSquircle(u: number, v: number, inset: number, n = 5): boolean {
	const x = Math.abs((u - 0.5) / (0.5 - inset));
	const y = Math.abs((v - 0.5) / (0.5 - inset));
	return x ** n + y ** n <= 1;
}

function bezier(p0: Pt, p1: Pt, p2: Pt, steps = 48): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const a = (1 - t) ** 2;
		const b = 2 * (1 - t) * t;
		const c = t * t;
		out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
	}
	return out;
}

function distToPolyline(u: number, v: number, pts: Pt[]): number {
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = pts[i - 1];
		const [x1, y1] = pts[i];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const t = clamp(((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy));
		best = Math.min(best, Math.hypot(u - (x0 + t * dx), v - (y0 + t * dy)));
	}
	return best;
}

// 两套尺寸参数：大图细致一些，小图线条和节点都加粗、去掉细节
function design(small: boolean) {
	const hub: Pt = [0.33, 0.5];
	const nodes: { at: Pt; color: RGBA }[] = [
		{ at: [0.74, 0.27], color: hex('#22d3ee') },
		{ at: [0.78, 0.5], color: hex('#fbbf24') },
		{ at: [0.74, 0.73], color: hex('#34d399') },
	];
	const curves = nodes.map((n) => bezier(hub, [(hub[0] + n.at[0]) / 2, n.at[1]], n.at));
	return {
		hub,
		nodes,
		curves,
		line: small ? 0.055 : 0.032,
		hubR: small ? 0.15 : 0.125,
		coreR: small ? 0 : 0.055,
		nodeR: small ? 0.105 : 0.078,
		ring: small ? 0 : 0.022,
		detail: !small,
	};
}

// 归一化坐标 (0~1) 上的颜色（不透明度在第 4 位，0~1），按从下往上的图层叠加
function shade(u: number, v: number, d: ReturnType<typeof design>): RGBA | null {
	if (!inSquircle(u, v, 0.02)) return null;
	// 背景：左上亮蓝 → 右下紫
	const t = clamp((u * 0.55 + v * 0.45 - 0.05) / 0.9);
	let c = mix(hex('#3b82f6'), hex('#7c3aed'), t);
	if (d.detail) {
		// 顶部柔光、底部略暗，带一点立体感
		const glow = clamp(1 - Math.hypot((u - 0.32) / 0.75, (v - 0.05) / 0.45));
		c = mix(c, hex('#ffffff'), glow * 0.22);
		c = mix(c, hex('#1e1b4b'), clamp((v - 0.6) / 0.4) * 0.25);
		// 中心节点周围的光晕
		const halo = clamp(1 - Math.hypot(u - d.hub[0], v - d.hub[1]) / 0.32);
		c = mix(c, hex('#c7d2fe'), halo ** 2 * 0.35);
	}
	// 三条弧线
	for (const pts of d.curves) {
		if (distToPolyline(u, v, pts) <= d.line / 2) c = mix(c, hex('#ffffff'), 0.92);
	}
	// 三个节点：白边 + 彩色芯
	for (const n of d.nodes) {
		const r = Math.hypot(u - n.at[0], v - n.at[1]);
		if (r <= d.nodeR) c = r > d.nodeR - d.ring ? hex('#ffffff') : n.color;
	}
	// 调度中心：白色圆 + 渐变内核
	const rh = Math.hypot(u - d.hub[0], v - d.hub[1]);
	if (rh <= d.hubR) c = hex('#ffffff');
	if (d.coreR && rh <= d.coreR) c = mix(hex('#6366f1'), hex('#8b5cf6'), clamp((v - d.hub[1] + d.coreR) / (2 * d.coreR)));
	return c;
}

// 每个像素多点采样求平均，得到抗锯齿后的 RGBA（0~255，非预乘）
function renderRGBA(size: number): Buffer {
	const d = design(size <= 24);
	const ss = size <= 48 ? 8 : 4;
	const px = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = 0; sy < ss; sy++) {
				for (let sx = 0; sx < ss; sx++) {
					const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, d);
					if (!c) continue;
					r += c[0] * c[3];
					g += c[1] * c[3];
					b += c[2] * c[3];
					a += c[3];
				}
			}
			const o = (y * size + x) * 4;
			px[o] = a ? Math.round(r / a) : 0;
			px[o + 1] = a ? Math.round(g / a) : 0;
			px[o + 2] = a ? Math.round(b / a) : 0;
			px[o + 3] = Math.round((a / (ss * ss)) * 255);
		}
	}
	return px;
}

// ICO 里的 BMP：行从下往上、像素 BGRA，后面跟一块全 0 的掩码
function toBmp(size: number, rgba: Buffer): Buffer {
	const px = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			const o = ((size - 1 - y) * size + x) * 4;
			px[o] = rgba[i + 2];
			px[o + 1] = rgba[i + 1];
			px[o + 2] = rgba[i];
			px[o + 3] = rgba[i + 3];
		}
	}
	const maskRow = Math.ceil(size / 32) * 4;
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(px.length + maskRow * size, 20);
	return Buffer.concat([header, px, Buffer.alloc(maskRow * size)]);
}

function toPng(w: number, h: number, rgba: Buffer): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 预览：上排浅色底、下排深色底，各放 256 / 64 / 32 / 16 像素（小图按整数倍放大，看得到实际像素）
function preview(file: string): void {
	const W = 760;
	const H = 620;
	const img = Buffer.alloc(W * H * 4);
	const fill = (y0: number, y1: number, c: RGBA) => {
		for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) img.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
	};
	fill(0, H / 2, hex('#f4f6f9'));
	fill(H / 2, H, hex('#0f1218'));
	const blit = (size: number, scale: number, x0: number, y0: number) => {
		const src = renderRGBA(size);
		for (let y = 0; y < size * scale; y++) {
			for (let x = 0; x < size * scale; x++) {
				const i = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
				const o = ((y0 + y) * W + x0 + x) * 4;
				const a = src[i + 3] / 255;
				for (let k = 0; k < 3; k++) img[o + k] = Math.round(src[i + k] * a + img[o + k] * (1 - a));
			}
		}
	};
	for (const [row, y0] of [
		[0, 22],
		[1, H / 2 + 22],
	] as const) {
		void row;
		blit(256, 1, 24, y0);
		blit(64, 2, 310, y0 + 64);
		blit(32, 4, 460, y0 + 64);
		blit(16, 8, 610, y0 + 64);
	}
	fs.writeFileSync(file, toPng(W, H, img));
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => toBmp(s, renderRGBA(s)));
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
	const e = 6 + i * 16;
	dir.writeUInt8(s === 256 ? 0 : s, e);
	dir.writeUInt8(s === 256 ? 0 : s, e + 1);
	dir.writeUInt16LE(1, e + 4);
	dir.writeUInt16LE(32, e + 6);
	dir.writeUInt32LE(images[i].length, e + 8);
	dir.writeUInt32LE(offset, e + 12);
	offset += images[i].length;
});
const out = path.join(import.meta.dirname, '..', 'ui', 'favicon.ico');
fs.writeFileSync(out, Buffer.concat([dir, ...images]));
console.log(`已生成 ${out}（${sizes.join('/')} 像素）`);
if (process.argv[2]) {
	preview(process.argv[2]);
	console.log(`预览：${process.argv[2]}`);
}
