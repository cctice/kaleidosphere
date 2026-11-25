// tests/ks-spark-filter.test.js — spark 检索过滤面（维护包二十二轮）
//
// 痛点：list/find 只能全量扫——真实库 scope 有非 global 值（"跨模块发布需求"等），
// 知识库长大以后按 scope 取子集、封顶条数是检索刚需。本面钉死三件事：
//   ① --scope 按 frontmatter scope 精确过滤（缺元信息按 global 兜底，与 listSparks 同口径）；
//   ② --limit 封顶 + truncated/totalSparks 对账随行（消费方看得见拿到的是不是全量）；
//   ③ find 的 --scope 先滤后扫——scannedSparks 反映 scope 过滤后的扫描面，不翻无关子集。
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

// 两条火花：一 global 一非 global（scope 真实库非全 global，手工落 frontmatter 模拟）
function setupTwoSparks(home) {
  const projectRoot = join(home, 'projects');
  const workspace = join(projectRoot, 'work');
  const sparks = join(projectRoot, 'sparks');
  mkdirSync(sparks, { recursive: true });
  writeFileSync(join(sparks, 'global-note.md'),
    '---\ntitle: Global Note\ndate: 2026-11-01\nscope: global\n---\n\n# Global Note\n\ntailscale 拓扑账。\n');
  writeFileSync(join(sparks, 'scoped-note.md'),
    '---\ntitle: Scoped Note\ndate: 2026-11-02\nscope: 跨模块发布需求\n---\n\n# Scoped Note\n\ntailscale 发布协作账。\n');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  return { sparks, workspace };
}

test('ks spark list --scope filters by frontmatter scope with honest accounting', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-filter-'));
  const { sparks } = setupTwoSparks(home);

  const scoped = JSON.parse(runKs(['spark', 'list', '--home', home, '--scope', 'global', '--json']).stdout);
  assert.equal(scoped.scope, 'global');
  assert.equal(scoped.totalSparks, 1);
  assert.equal(scoped.truncated, false);
  assert.equal(scoped.sparks.length, 1);
  assert.equal(scoped.sparks[0].title, 'Global Note');

  const nonGlobal = JSON.parse(runKs(['spark', 'list', '--home', home, '--scope', '跨模块发布需求', '--json']).stdout);
  assert.equal(nonGlobal.sparks.length, 1);
  assert.equal(nonGlobal.sparks[0].title, 'Scoped Note');

  // 未过滤面回真话：totalSparks=全量 2（scope=null），不假装过滤过
  const plain = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(plain.scope, null);
  assert.equal(plain.totalSparks, 2);
  assert.equal(plain.sparks.length, 2);

  // 空 scope 如实空——不编造、不回落全量
  const empty = JSON.parse(runKs(['spark', 'list', '--home', home, '--scope', '不存在的scope', '--json']).stdout);
  assert.equal(empty.totalSparks, 0);
  assert.deepEqual(empty.sparks, []);
  assert.ok(sparks);
});

test('ks spark find --scope scans only the scoped subset and matches within it', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-filter-'));
  setupTwoSparks(home);

  // "tailscale" 两条都命中——--scope global 先滤后扫：scannedSparks=1（不是 2）
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--scope', 'global', '--json']).stdout);
  assert.equal(found.scope, 'global');
  assert.equal(found.scannedSparks, 1);
  assert.equal(found.matchedSparks, 1);
  assert.equal(found.sparks.length, 1);
  assert.equal(found.sparks[0].title, 'Global Note');

  // scope 内无命中如实报空，对账面照常随行
  const none = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--scope', '不存在的scope', '--json']).stdout);
  assert.equal(none.scannedSparks, 0);
  assert.equal(none.matchedSparks, 0);
  assert.deepEqual(none.sparks, []);
});

test('ks spark list/find --limit caps rows with truncated and totalSparks accounting', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-filter-'));
  setupTwoSparks(home);

  const limited = JSON.parse(runKs(['spark', 'list', '--home', home, '--limit', '1', '--json']).stdout);
  assert.equal(limited.sparks.length, 1);
  assert.equal(limited.totalSparks, 2);
  assert.equal(limited.truncated, true);

  const unlimited = JSON.parse(runKs(['spark', 'list', '--home', home, '--limit', '5', '--json']).stdout);
  assert.equal(unlimited.sparks.length, 2);
  assert.equal(unlimited.truncated, false);

  // find 同款：matchedSparks=totalSparks=2 是匹配面真值，sparks 被 --limit 截到 1，truncated 点名
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--limit', '1', '--json']).stdout);
  assert.equal(found.matchedSparks, 2);
  assert.equal(found.sparks.length, 1);
  assert.equal(found.truncated, true);
  assert.equal(found.totalSparks, 2);
});

test('ks spark rejects an invalid --limit instead of guessing', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-filter-'));
  setupTwoSparks(home);
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    const result = runKs(['spark', 'list', '--home', home, '--limit', bad, '--json']);
    assert.equal(result.status, 1, `--limit ${bad} must exit 1`);
    assert.match(result.stderr, /--limit must be a positive integer/);
  }
});
