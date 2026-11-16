// tests/ks-replay-todo.test.js — 回放失败留痕（维护心跳包·十三轮）：
// 重放报告此前只在响应面——回放方（快捷指令）自己不记账，失败条目终端一滚就没。
// 现在失败条目落 state/replay-todo.json 本地待办，--show-todo 随时回看，重放成功即销账。
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', join(home, 'sparks')]).status, 0);
  return home;
}

test('回放失败落待办：state/replay-todo.json 有失败条目（title/error/原始 entry 可回溯）', () => {
  const home = setupHome();
  const queue = join(home, 'queue.json');
  writeFileSync(queue, JSON.stringify([
    { title: '好条目', text: '正常内容' },
    { title: 42 },
  ]), 'utf8');
  const mixed = runKs(['spark', 'capture', '--batch', queue, '--home', home]);
  assert.equal(mixed.status, 1);
  const report = JSON.parse(mixed.stdout);
  assert.equal(report.todoPending, 1, '响应面带待办计数指路');
  assert.match(report.todoHint, /replay-todo/);

  const todo = JSON.parse(readFileSync(join(home, 'state', 'replay-todo.json'), 'utf8'));
  assert.equal(todo.pending.length, 1);
  assert.equal(todo.pending[0].index, 1);
  assert.equal(todo.pending[0].error, 'entry must be {title: string, text: string, source?: string}');
  assert.deepEqual(todo.pending[0].entry, { title: 42 }, '原始条目随行，重排不用翻队列文件');
});

test('修好重放即销账：同条目这次过了就出队，--show-todo 归零', () => {
  const home = setupHome();
  const queue = join(home, 'queue.json');
  writeFileSync(queue, JSON.stringify([{ title: '', text: '标题空' }]), 'utf8');
  assert.equal(runKs(['spark', 'capture', '--batch', queue, '--home', home]).status, 1);

  writeFileSync(queue, JSON.stringify([{ title: '修好了', text: '标题补上' }]), 'utf8');
  assert.equal(runKs(['spark', 'capture', '--batch', queue, '--home', home]).status, 0);
  const show = JSON.parse(runKs(['spark', 'capture', '--show-todo', '--home', home]).stdout);
  assert.equal(show.pending, 0, '成功重放销账');
  assert.match(show.note, /fully drained/);
});

test('重复失败不重复堆积；--show-todo 按批分组列单', () => {
  const home = setupHome();
  const queue = join(home, 'queue.json');
  writeFileSync(queue, JSON.stringify([{ title: '', text: 'x' }]), 'utf8');
  runKs(['spark', 'capture', '--batch', queue, '--home', home]);
  runKs(['spark', 'capture', '--batch', queue, '--home', home]); // 同批再失败一次
  const show = JSON.parse(runKs(['spark', 'capture', '--show-todo', '--home', home]).stdout);
  assert.equal(show.pending, 1, '同批同条目幂等留痕不堆积');
  assert.equal(show.batches.length, 1);
  assert.equal(show.batches[0].failed, 1);
  assert.equal(show.batches[0].entries[0].title, '', '失败原因面可见');
});

test('失败条目有界：封顶 500 最旧让位（只增不删的病不进待办）', () => {
  const home = setupHome();
  const todoPath = join(home, 'state', 'replay-todo.json');
  const dir = join(home, 'state');
  const { mkdirSync, writeFileSync: wf } = require('node:fs');
  mkdirSync(dir, { recursive: true });
  const fake = [];
  for (let i = 0; i < 510; i += 1) fake.push({ batch: '/old.json', index: i, title: `t${i}`, error: 'e', entry: null, at: '2026-01-01T00:00:00Z' });
  wf(todoPath, JSON.stringify({ pending: fake, updatedAt: '2026-01-01T00:00:00Z' }), 'utf8');
  // 触发一次重放（全失败 1 条）→ 有界收敛 500
  const queue = join(home, 'q.json');
  writeFileSync(queue, JSON.stringify([{ title: '', text: 'x' }]), 'utf8');
  runKs(['spark', 'capture', '--batch', queue, '--home', home]);
  const todo = JSON.parse(readFileSync(todoPath, 'utf8'));
  assert.equal(todo.pending.length, 500, '封顶 500');
  assert.equal(todo.pending[499].title, '', '最新失败在队尾');
  assert.equal(todo.pending[0].index, 11, '最旧的 10 条让位');
});
