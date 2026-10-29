// tests/ks-behavior-surface.test.js — 行为面覆盖（维护心跳包·九轮）
//
// 痛点：market/route/spark capture 测试覆盖仍偏发现面（list/search 的形状对了，
// 行为链路却没人盯）。本文件补四条行为链：
//   ① 并发 route：两个真实进程同时转动，withStateLock 串行化——选择不撞车、历史不丢条
//   ② rotation 历史封顶 50：长跑不膨胀（state 真源预先灌满再转一轮，尾部收敛）
//   ③ spark capture → spark find/list 回溯闭环：采集的东西列表里真找得回（source 元信息随行）
//   ④ capture 重名拒绝：同一标题二采不覆盖已有火花
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupProjects(home, names) {
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  for (const name of names) {
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']).status, 0);
  }
}

function runKsAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

test('并发 route：两进程同时转动不撞车，历史完整落档（withStateLock 行为链）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma', 'delta']);

  const [first, second] = await Promise.all([
    runKsAsync(['route', '--home', home]),
    runKsAsync(['route', '--home', home]),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const pickedA = JSON.parse(first.stdout).project.name;
  const pickedB = JSON.parse(second.stdout).project.name;
  assert.notEqual(pickedA, pickedB, '锁串行化后两进程必须选中不同项目（least-recently-routed 各自成立）');

  const rotation = JSON.parse(readFileSync(join(home, 'state', 'rotation.json'), 'utf8'));
  assert.equal(rotation.history.length, 2, '两次转动各落一条，谁也不覆盖谁');
});

test('rotation 历史封顶 50：灌满历史再转，尾部收敛不膨胀', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);
  mkdirSync(join(home, 'state'), { recursive: true });
  const history = Array.from({ length: 55 }, (_, i) => ({
    projectId: `stale-${i}`,
    routedAt: new Date(Date.now() - (100 - i) * 60000).toISOString(),
  }));
  writeFileSync(join(home, 'state', 'rotation.json'), JSON.stringify({ schemaVersion: 1, history }));

  const routed = JSON.parse(runKs(['route', '--home', home]).stdout);
  assert.equal(routed.ok, true);
  const rotation = JSON.parse(readFileSync(join(home, 'state', 'rotation.json'), 'utf8'));
  assert.equal(rotation.history.length, 50, '封顶 50：转一轮丢最旧，不无限增长');
  assert.ok(!rotation.history.some((r) => r.projectId === 'stale-0' || r.projectId === 'stale-4'), '最旧的陈记录先出局');
  assert.ok(rotation.history.some((r) => r.projectId === 'stale-54'), '较新的陈记录仍在场');
});

test('spark capture → find/list 回溯闭环：采进来的火花列表真找得回，source 元信息随行', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', join(home, 'sparks')]).status, 0);
  const captured = JSON.parse(runKs([
    'spark', 'capture', '--home', home, '--source', 'im', '--title', '移动壳路由想法', '--text', 'route 单行输出给快捷指令用', '--json',
  ]).stdout);
  assert.equal(captured.ok, true);
  assert.equal(captured.source, 'im');

  const listed = JSON.parse(runKs(['spark', 'list', '--home', home]).stdout);
  const found = listed.sparks.find((s) => s.id === captured.spark.id);
  assert.ok(found, '采集的火花必须在 spark list 可见（行为闭环，不是只写了文件）');

  const inspected = JSON.parse(runKs(['spark', 'inspect', '--home', home, '--id', captured.spark.id]).stdout);
  const frontmatter = typeof inspected.spark === 'string' ? inspected.spark : JSON.stringify(inspected);
  assert.match(frontmatter, /source: im/, 'source 元信息回溯可见');
});

test('capture 重名拒绝：同一标题二采不许覆盖已有火花', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', join(home, 'sparks')]).status, 0);
  const first = runKs(['spark', 'capture', '--home', home, '--source', 'im', '--title', '重复标题', '--text', '第一次', '--json']);
  assert.equal(first.status, 0);
  const second = runKs(['spark', 'capture', '--home', home, '--source', 'mail', '--title', '重复标题', '--text', '第二次想覆盖', '--json']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
});
