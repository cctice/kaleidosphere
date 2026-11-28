// tests/ks-spark-restore.test.js — spark 回收站恢复面（维护包二十五轮）
//
// 痛点：rm 的安全网是"手工找回"——得知道 .trash 目录约定+时间戳文件名才能捞回，
// 恢复动线没有一等公民入口。ks spark restore 两条：--list 清单（原名/标题/
// 入站时刻 mtime 真源）+ --id 捞回顶层；捞回与 rm 契约互为反面：trash 不挡名
// （rm 后可重建），restore 不覆盖活档（同名已重建宁红勿默）。
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs');
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

function rmOne(home, title) {
  const created = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', title, '--json']).stdout);
  const removed = JSON.parse(runKs(['spark', 'rm', '--home', home, '--id', created.spark.id, '--json']).stdout);
  assert.equal(removed.ok, true, `rm ${title} 前置失败`);
  return { created, removed };
}

test('restore --list：回收站清单如实（原名/标题/时刻/计数），空回收站如实空', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-restore-'));
  setup(home);
  const empty = JSON.parse(runKs(['spark', 'restore', '--list', '--home', home, '--json']).stdout);
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.items, []);

  rmOne(home, 'Oops One');
  rmOne(home, 'Oops Two');
  const listed = JSON.parse(runKs(['spark', 'restore', '--list', '--home', home, '--json']).stdout);
  assert.equal(listed.count, 2);
  const titles = listed.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Oops One', 'Oops Two']);
  for (const item of listed.items) {
    assert.match(item.original, /^[\w.-]+\.md$/, '原名从时间戳文件名剥回');
    assert.match(item.id, /-\d{4}-\d{2}-\d{2}T[\d-]+Z?$/, '条目 id 即 trash 文件基名（带时间戳）');
    assert.ok(item.id.startsWith(item.original.replace(/\.md$/, '')), '时间戳前的部分=原文件基名');
    assert.ok(Date.parse(item.trashedAt) > 0, '入站时刻取 mtime 真源');
    assert.ok(item.sizeBytes > 0);
  }
});

test('restore --id：捞回顶层目录，list/find 重新可见，trash 清空', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-restore-'));
  const { sparks } = setup(home);
  const { removed } = rmOne(home, 'Precious Note');

  const trashId = removed.trashPath.split('/').pop().replace(/\.md$/, '');
  const restored = JSON.parse(runKs(['spark', 'restore', '--id', trashId, '--home', home, '--json']).stdout);
  assert.equal(restored.ok, true);
  assert.equal(restored.restored.original, 'precious-note.md');
  assert.ok(existsSync(join(sparks, restored.restored.original)), '捞回文件在场');
  assert.ok(!existsSync(removed.trashPath), 'trash 条目已清');

  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'precious', '--json']).stdout);
  assert.equal(found.matchedSparks, 1, 'find 重新可见');
});

test('restore 不覆盖活档：同名已重建宁红勿默，trash 条目原样保留', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-restore-'));
  const { sparks } = setup(home);
  const { removed } = rmOne(home, 'Same Title');

  // rm 后重建同标题（trash 不挡名——二十二轮契约），restore 此时必须拒绝覆盖
  const recreated = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', 'Same Title', '--json']).stdout);
  assert.ok(existsSync(recreated.spark.path));

  const trashId = removed.trashPath.split('/').pop().replace(/\.md$/, '');
  const refuse = runKs(['spark', 'restore', '--id', trashId, '--home', home, '--json']);
  assert.equal(refuse.status, 1, '宁红勿默');
  assert.match(refuse.stderr, /already exists at top level/);
  assert.match(refuse.stderr, /never overwrites/);
  assert.ok(existsSync(removed.trashPath), 'trash 条目原样保留');
  assert.ok(existsSync(recreated.spark.path), '活档分毫不动');
});

test('restore 未知条目/坏输入宁红勿默；手工塞进 .trash 的裸文件（无时间戳）也按原名捞', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-restore-'));
  const { sparks } = setup(home);
  const missing = runKs(['spark', 'restore', '--id', 'spk_no_such', '--home', home, '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such trash entry/);

  // 边界：手工放进 .trash 的无时间戳文件——原名剥离不误伤（整名即原名）
  const trashDir = join(sparks, '.trash');
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(join(trashDir, 'hand-made.md'), '---\ntitle: Hand Made\n---\n\n# Hand Made\n');
  const listed = JSON.parse(runKs(['spark', 'restore', '--list', '--home', home, '--json']).stdout);
  assert.equal(listed.count, 1);
  assert.equal(listed.items[0].original, 'hand-made.md', '无时间戳文件原名=自身');
  const restored = JSON.parse(runKs(['spark', 'restore', '--id', 'hand-made', '--home', home, '--json']).stdout);
  assert.equal(restored.restored.original, 'hand-made.md');
  assert.ok(existsSync(join(sparks, 'hand-made.md')));
});
