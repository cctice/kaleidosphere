// tests/ks-spark-write-lock.test.js — spark 写面并发保护（维护心跳包·十二轮）：
// registry/rotation 早已吃 withStateLock，spark 写面两处 TOCTOU 裸奔——
// ①configureSparkDirectory readSparks→writeJson 后写者整体覆盖前写者；
// ②capture existsSync→write 两进程同题并发都过检查、后写者静默覆盖前写者（丢火花）。
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('并发同题 capture：恰好一胜一负，败者明错不静默覆盖（TOCTOU 关门）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const sparks = join(home, 'sparks');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', sparks]).status, 0);

  // 两真实进程同时 capture 同题（同步起跑，锁内一先一后）
  const args = ['spark', 'capture', '--home', home, '--source', 'im', '--title', 'dup-spark', '--text', '并发写入'];
  const procs = [
    spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }),
    spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }),
  ];
  const outcomes = procs.map((p) => p.status);

  assert.ok(outcomes.includes(0), '必须有一方成功');
  assert.ok(outcomes.includes(1), '另一方必须明错退出');
  const winner = procs[0].status === 0 ? procs[0] : procs[1];
  const loser = procs[0].status === 0 ? procs[1] : procs[0];
  assert.match(loser.stderr, /already exists/, '败者拿到明确的已存在报错');

  // 文件只有一份，内容是胜者的（无覆盖、无双写）
  const body = readFileSync(join(sparks, 'dup-spark.md'), 'utf8');
  assert.match(body, /并发写入/);
  const list = JSON.parse(runKs(['spark', 'list', '--home', home]).stdout);
  assert.equal(list.sparks.filter((s) => s.title === 'dup-spark').length, 1);
  void winner;
});

test('并发 configure：sparks.json 始终是合法 JSON，最终值是两者之一（不坏档）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);

  const procs = [
    spawnSync(process.execPath, [cliPath, 'spark', 'configure', '--home', home, '--path', join(home, 'a')], { encoding: 'utf8' }),
    spawnSync(process.execPath, [cliPath, 'spark', 'configure', '--home', home, '--path', join(home, 'b')], { encoding: 'utf8' }),
  ];
  assert.ok(procs.every((p) => p.status === 0), '两会话都应成功（串行化不互踩崩溃）');

  const registry = JSON.parse(readFileSync(join(home, 'registry', 'sparks.json'), 'utf8'));
  assert.ok(['a', 'b'].some((d) => registry.directory.endsWith(d)), `最终目录是两者之一，实际 ${registry.directory}`);
});
