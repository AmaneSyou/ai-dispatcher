import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppearanceError, applyAppearance, backgroundPath, detectImage, removeBackground, saveBackground } from '../src/appearance.ts';
import type { Config } from '../src/config.ts';
import { appearanceOf } from '../src/config.ts';

function setup(): Config {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-look-'));
	process.env.DISPATCHER_CONFIG = path.join(root, 'config.json');
	return {
		workRoot: root,
		git: 'git',
		dashboard: { host: '127.0.0.1', port: 0 },
		agents: { dsh: { install: '', concurrency: 1, maxAttempts: 1, timeoutMinutes: 1, keyFile: '', dailyTokenBudget: 1 } },
		projects: {},
	};
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test('认图片格式只看文件开头：PNG / JPG / WebP / GIF；别的一律不收', () => {
	assert.equal(detectImage(PNG), 'png');
	assert.equal(detectImage(JPG), 'jpg');
	assert.equal(detectImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
	assert.equal(detectImage(Buffer.from('GIF89a....')), 'gif');
	assert.equal(detectImage(Buffer.from('<svg onload="x">')), null);
	assert.equal(detectImage(Buffer.from('MZ\x90\0')), null);
});

test('上传背景：存进 ui-assets，换图时删掉旧图；移除后配置清空；不是图片或太大就拒绝', () => {
	const cfg = setup();
	const first = saveBackground(cfg, `data:image/png;base64,${PNG.toString('base64')}`);
	const p1 = backgroundPath(cfg)!;
	assert.ok(p1.endsWith(first) && fs.existsSync(p1));
	assert.ok(p1.startsWith(path.join(cfg.workRoot, 'ui-assets')));
	saveBackground(cfg, JPG.toString('base64'));
	assert.ok(!fs.existsSync(p1), '旧图被删掉');
	assert.match(appearanceOf(cfg).background!, /\.jpg$/);
	assert.ok(fs.existsSync(path.join(cfg.workRoot, 'config.json')), '保存到了配置文件');

	assert.throws(() => saveBackground(cfg, Buffer.from('hello').toString('base64')), AppearanceError);
	assert.throws(() => saveBackground(cfg, ''), /没有收到图片/);
	assert.throws(() => saveBackground(cfg, Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]).toString('base64')), /太大/);

	removeBackground(cfg);
	assert.equal(backgroundPath(cfg), null);
	assert.equal(appearanceOf(cfg).background, null);
});

test('配置里的文件名被改成别的路径：当作没有背景，不会读到别处的文件', () => {
	const cfg = setup();
	cfg.appearance = { background: '..\\..\\secrets\\deepseek.key', panelOpacity: 80, blur: 0, dim: 0 };
	assert.equal(backgroundPath(cfg), null);
});

test('外观数值：在范围内才保存', () => {
	const cfg = setup();
	applyAppearance(cfg, { panelOpacity: 60, blur: 12, dim: 40 });
	assert.deepEqual(appearanceOf(cfg), { background: null, panelOpacity: 60, blur: 12, dim: 40 });
	assert.throws(() => applyAppearance(cfg, { panelOpacity: 10 }), /面板不透明度/);
	assert.throws(() => applyAppearance(cfg, { blur: 99 }), /毛玻璃/);
	assert.throws(() => applyAppearance(cfg, { dim: 1.5 }), /背景变暗/);
});
