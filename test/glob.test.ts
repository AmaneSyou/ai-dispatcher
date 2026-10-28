import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROTECTED } from '../src/config.ts';
import { matchAny } from '../src/glob.ts';

test('** 跨目录，* 不跨目录', () => {
	assert.ok(matchAny('src/a/b.ts', ['src/**']));
	assert.ok(matchAny('src/b.ts', ['src/*.ts']));
	assert.ok(!matchAny('src/a/b.ts', ['src/*.ts']));
	assert.ok(matchAny('a.test.ts', ['**/*.test.ts']));
	assert.ok(matchAny('deep/x/a.test.ts', ['**/*.test.ts']));
});

test('Windows 分隔符和大小写', () => {
	assert.ok(matchAny('Src\\A.ts', ['src/**']));
});

test('默认受保护路径', () => {
	assert.ok(matchAny('.env', DEFAULT_PROTECTED));
	assert.ok(matchAny('app/.env.local', DEFAULT_PROTECTED));
	assert.ok(matchAny('pnpm-lock.yaml', DEFAULT_PROTECTED));
	assert.ok(matchAny('src-tauri/Cargo.lock', DEFAULT_PROTECTED));
	assert.ok(matchAny('.github/workflows/build.yml', DEFAULT_PROTECTED));
	assert.ok(!matchAny('src/env.ts', DEFAULT_PROTECTED));
	// 验收时会被执行的构建配置
	assert.ok(matchAny('src-tauri/build.rs', DEFAULT_PROTECTED));
	assert.ok(matchAny('src-tauri/reina-path/build.rs', DEFAULT_PROTECTED));
	assert.ok(matchAny('src-tauri/.cargo/config.toml', DEFAULT_PROTECTED));
	assert.ok(matchAny('rust-toolchain.toml', DEFAULT_PROTECTED));
	assert.ok(matchAny('.npmrc', DEFAULT_PROTECTED));
	assert.ok(matchAny('pnpm-workspace.yaml', DEFAULT_PROTECTED));
	assert.ok(!matchAny('src-tauri/src/build_info.rs', DEFAULT_PROTECTED));
});
