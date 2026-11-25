// tests/ks-spark-rm.test.js — spark 内容生命周期：rm 归档面（维护包二十二轮）
//
// 痛点：spark 写面只有 create/append——只进不出，错字/过时火花无法下架。
// ks spark rm 不删档：移入 <sparks>/.trash/<name>-<UTC 时间戳>.md——list/find
// 天然不再见（顶层 isFile 过滤），误删可手工找回；同标题 rm 后可重建不挡名。
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setup(home) {
  const projectRoot = join(home, 'projects');
  const workspace = join(projectRoot, 'work');
  const sparks = join(projectRoot, 'sparks');
  mkdirSync(sparks, { recursive: true });
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  return { sparks };
}

test('ks spark rm moves the file into .trash and removes it from list/find', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-rm-'));
  const { sparks } = setup(home);
  const created = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', 'Typo Spark', '--json']).stdout);
  const id = created.spark.id;
  const originalPath = created.spark.path;
  assert.ok(existsSync(originalPath));

  const removed = JSON.parse(runKs(['spark', 'rm', '--home', home, '--id', id, '--json']).stdout);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed.id, id);
  assert.equal(removed.removed.title, 'Typo Spark');
  assert.equal(removed.removed.path, originalPath);
  assert.ok(existsSync(removed.trashPath), 'trash file must exist');
  assert.ok(removed.trashPath.startsWith(join(sparks, '.trash')), 'trash file lives in <sparks>/.trash/');
  assert.ok(!existsSync(originalPath), 'original path must be gone');

  // list/find 天然不再见（.trash 子目录不进顶层扫描面）
  const listed = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(listed.sparks.length, 0);
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'typo', '--json']).stdout);
  assert.equal(found.matchedSparks, 0);

  // rm 未知 id：宁红勿默
  const missing = runKs(['spark', 'rm', '--home', home, '--id', 'spk_does_not_exist', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /spark does not exist/);
});

test('ks spark rm then recreate the same title succeeds without trash collision', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-rm-'));
  const { sparks } = setup(home);
  const first = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', 'Reuse Spark', '--json']).stdout);
  runKs(['spark', 'rm', '--home', home, '--id', first.spark.id, '--json']);

  // 同标题重建不被 .trash 里的旧档挡名——slug 只看主目录，重建落回同一路径
  const second = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', 'Reuse Spark', '--json']).stdout);
  assert.equal(second.spark.title, 'Reuse Spark');
  assert.equal(second.spark.path, first.spark.path);
  assert.ok(existsSync(second.spark.path));

  const trashRows = readdirSync(join(sparks, '.trash')).filter((name) => name.endsWith('.md'));
  assert.equal(trashRows.length, 1, 'trash keeps the removed copy');

  const listed = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(listed.sparks.length, 1);
});
