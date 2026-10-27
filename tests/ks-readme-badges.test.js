// tests/ks-readme-badges.test.js — README 徽章与实现同步防线（维护包三轮：清单强化）
//
// 徽章是仓库门面，漂移即虚假广告：version 徽章应等于 package.json 版本、
// node 徽章应等于 engines 声明、afk bundled 徽章应有真实 bundled 标记背书。
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readmeCn = readFileSync(join(root, 'README_CN.md'), 'utf8');

test('version badge matches package.json version', () => {
  const m = readme.match(/badge\/version-([\d.]+)-/);
  assert.ok(m, 'README 缺 version 徽章');
  assert.equal(m[1], pkg.version, `version 徽章 ${m[1]} ≠ package.json ${pkg.version}`);
});

test('node badge claim matches package.json engines (双语文档同检)', () => {
  const m = readme.match(/badge\/node-([^?]+)/);
  assert.ok(m, 'README 缺 node 徽章');
  assert.ok(pkg.engines && pkg.engines.node, 'package.json 缺 engines.node——node 徽章的声称无实现背书');
  // 剥离 shields 色值后缀（如 >=18-339933 中的 339933）
  const claim = decodeURIComponent(m[1].replace(/-[0-9a-fA-F]{6}$/, '').replace(/%3E%3D/g, '>='));
  assert.equal(claim, pkg.engines.node, `node 徽章声称 ${claim} ≠ engines "${pkg.engines.node}"`);
  assert.ok(readmeCn.includes(pkg.engines.node) || readmeCn.includes('Node'), 'README_CN 未提 Node 版本要求');
});

test('afk engine bundled badge is backed by a real bundled manifest', () => {
  assert.match(readme, /afk_engine-bundled/, 'README 缺 afk engine 徽章');
  const manifestPath = join(root, 'plugins', 'afk', 'plugin.json');
  assert.ok(existsSync(manifestPath), '徽章指向的 plugins/afk/plugin.json 不存在');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'afk');
  assert.equal(
    manifest.bundled === true || manifest.integration?.bundled === true,
    true,
    'plugin.json 未声明 bundled=true——徽章虚假',
  );
});

test('tests badge link points at the real test directory', () => {
  assert.match(readme, /badge\/tests-/);
  assert.ok(existsSync(join(root, 'tests')), 'tests 徽章链接的 tests/ 目录不存在');
});
