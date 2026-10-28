// tests/ks-plugin-contract.test.js — 插件契约收敛门（维护包四轮）
//
// 历史痛点：插件契约双形态（skills 数组 / 目录引用）靠桥适配补丁支撑，
// 每接一个插件都要再付一次适配税。本轮把契约收敛为单一规范：
// skills 必须是目录引用 './skills/'；旧数组形态由装载侧统一归一化并打标记。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('bundled afk 插件按 canonical 契约装载（skills 为目录引用，无需归一化）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const listed = JSON.parse(runKs(['plugin', 'list', '--home', home]).stdout);
  const afk = listed.plugins.find((plugin) => plugin.name === 'afk');
  assert.ok(afk, 'plugin list 未发现 bundled afk');
  assert.equal(afk.skills, './skills/');
  assert.equal(afk.normalized, false, 'canonical 形态不应触发归一化');
  assert.equal(afk.passed, true);
  assert.equal(afk.source, 'bundled');

  const checked = JSON.parse(runKs(['plugin', 'check', '--home', home]).stdout);
  assert.equal(checked.compliant, true);
});

test('历史数组形态被装载侧统一归一化并打 normalized 标记（不再各付桥适配税）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const legacyDir = join(home, 'plugins', 'legacy-plugin');
  mkdirSync(join(legacyDir, 'skills', 'legacy-flow'), { recursive: true });
  writeFileSync(join(legacyDir, 'skills', 'legacy-flow', 'SKILL.md'), '# legacy\n');
  writeFileSync(join(legacyDir, 'plugin.json'), JSON.stringify({
    name: 'legacy-plugin',
    version: '0.1.0',
    skills: ['./skills/legacy-flow']
  }));

  const listed = JSON.parse(runKs(['plugin', 'list', '--home', home]).stdout);
  const legacy = listed.plugins.find((plugin) => plugin.name === 'legacy-plugin');
  assert.ok(legacy, 'installed 插件未被发现');
  assert.equal(legacy.source, 'installed');
  assert.equal(legacy.normalized, true, '数组形态必须被标记为已归一化');
  assert.equal(legacy.skills, './skills/');
  assert.equal(legacy.passed, true);
});

test('违约清单（缺 name/version、skills 缺失、skills 目录不存在）在 check 门如实报红', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const brokenDir = join(home, 'plugins', 'broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'plugin.json'), JSON.stringify({ name: 'broken', skills: [] }));

  const checked = JSON.parse(runKs(['plugin', 'check', '--home', home]).stdout);
  assert.equal(checked.compliant, false);
  const broken = checked.plugins.find((plugin) => plugin.name === 'broken');
  assert.ok(broken.issues.some((issue) => issue.includes('version')), '缺 version 未被点名');
  assert.ok(broken.issues.some((issue) => issue.includes("skills 字段")), 'skills 空数组未被点名');
  assert.ok(broken.issues.some((issue) => issue.includes('skills 目录不存在')), 'skills 目录缺失未被点名');
  assert.ok(broken.remediation, 'check 失败必须给出修复指引');
});
