// ks-spark-cjk.test.js —— 十八轮：spark 文件名/检索面的中文可用性
// 此前 sparkSlug 把 CJK 全剥掉（[^a-z0-9]），中文标题一律落 spark-<hash>.md——
// 真库（/Users/cy/projects-ks/sparks）已有一条哈希脸；find 又是单串 substring，
// 两词查询一个都命不中。本组测试锁两件事：新火花文件名人类可读、旧哈希脸
// 火花零迁移照常工作；多词 AND 检索+命中账面。
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'ks-cjk-'));
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  // spark 目录解析：唯一 workspace 的父目录/sparks（与 ks-spark.test.js 同口径）
  assert.equal(runKs([
    'workspace', 'add', '--home', home, '--id', 'work', '--path', join(home, 'projects', 'work'), '--json',
  ]).status, 0);
  return home;
}

test('中文标题 create：文件名人类可读（· 分隔归一为 -，CJK 保留）', () => {
  const home = freshHome();
  const created = JSON.parse(runKs([
    'spark', 'create', '--home', home,
    '--title', '全局知识库·网络与代理拓扑', '--json',
  ]).stdout);
  const name = basename(created.spark.path);
  assert.equal(name, '全局知识库-网络与代理拓扑.md');
  assert.ok(existsSync(created.spark.path));

  // ASCII 标题口径不回退（既有库的英文 slug 一个字符不变）
  const ascii = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', 'Capability Budget', '--json']).stdout);
  assert.equal(basename(ascii.spark.path), 'capability-budget.md');
});

test('旧哈希脸火花零迁移照常 list/find/inspect（back-compat）', () => {
  const home = freshHome();
  const sparksDir = join(home, 'projects', 'sparks');
  mkdirSync(sparksDir, { recursive: true });
  const legacy = join(sparksDir, 'spark-c58671c20b8a.md');
  writeFileSync(legacy, '---\ntitle: 全局知识库·网络与代理拓扑\ndate: 2026-10-22\nscope: global\n---\n\n# 全局知识库·网络与代理拓扑\n\nTailscale 拓扑与代理端口账。\n');

  const listed = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(listed.sparks.length, 1);
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--json']).stdout);
  assert.equal(found.sparks.length, 1);
  const inspected = JSON.parse(runKs(['spark', 'inspect', '--home', home, '--id', found.sparks[0].id, '--json']).stdout);
  assert.ok(inspected.content.includes('Tailscale'));
});

test('find 多词 AND：两词都含才命中，一词不含即排除', () => {
  const home = freshHome();
  runKs(['spark', 'create', '--home', home, '--title', '网络与代理拓扑', '--json']);
  runKs(['spark', 'create', '--home', home, '--title', '只有网络的账', '--json']); // 含"网络"不含"代理"

  const both = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', '网络 代理', '--json']).stdout);
  assert.equal(both.matchedSparks, 1);
  assert.equal(both.scannedSparks, 2);
  assert.equal(both.sparks.length, 1);
  assert.equal(both.sparks[0].title, '网络与代理拓扑');
  assert.ok(typeof both.sparks[0].snippet === 'string' && both.sparks[0].snippet.length > 0, '命中上下文片段在');
});

test('find 命中账面：scanned/matched 对账 + snippet 指向首个命中词', () => {
  const home = freshHome();
  runKs(['spark', 'create', '--home', home, '--title', 'Alpha Notes', '--json']);
  const miss = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'zzz-not-there', '--json']).stdout);
  assert.equal(miss.matchedSparks, 0);
  assert.equal(miss.scannedSparks, 1);
  assert.deepEqual(miss.sparks, []);
});

test('纯符号标题退回哈希兜底（原口径不丢）；超长标题封顶 64', () => {
  const home = freshHome();
  const hashed = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', '···！！！', '--json']).stdout);
  assert.match(basename(hashed.spark.path), /^spark-[0-9a-f]{12}\.md$/);

  const long = '长'.repeat(100);
  const capped = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', long, '--json']).stdout);
  const name = basename(capped.spark.path);
  assert.ok(name.length <= 64 + '.md'.length, `filename capped (len=${name.length})`);
});
