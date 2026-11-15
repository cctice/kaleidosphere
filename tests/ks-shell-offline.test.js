// tests/ks-shell-offline.test.js — 移动壳离线能力（维护心跳包·十二轮）：
// 第一步壳在线依赖 SSH，断网零能力。第二步读面走缓存计划（--plan 确定性预演）、
// 写面走离线队列重放（capture --batch 幂等回放）——全部与桌面同一状态面。
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

function setupProjects(home, names) {
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  for (const name of names) {
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']).status, 0);
  }
}

test('--plan 只读预演：rotation.json 分毫不动（真转动仍走 ks route）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma']);

  const plan = JSON.parse(runKs(['route', '--plan', '3', '--home', home]).stdout);
  assert.equal(plan.plan.length, 3);
  assert.ok(plan.generatedAt, '生成时间随行（离线读取时判断新鲜度）');
  assert.equal(existsSync(join(home, 'state', 'rotation.json')), false, '计划不得留转动记档');
});

test('--plan 与真转动同序：plan[0] 即下一次 ks route 的选择，转过一步后计划前移', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma']);

  const plan = JSON.parse(runKs(['route', '--plan', '3', '--home', home]).stdout);
  const routed = JSON.parse(runKs(['route', '--home', home]).stdout);
  assert.equal(plan.plan[0].name, routed.project.name, '预演第一步与真实选择一致');

  const planAfter = JSON.parse(runKs(['route', '--plan', '3', '--home', home]).stdout);
  assert.equal(planAfter.plan[0].name, plan.plan[1].name, '转过一步后计划整体前移（不重复已转项目）');
  assert.equal(new Set(plan.plan.map((s) => s.name)).size, 3, '同一步计划内项目不重复');
});

test('--plan --shell：每行 name<TAB>path，按未来转动顺序（快捷指令直接消费）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);

  const shell = runKs(['route', '--plan', '2', '--shell', '--home', home]);
  assert.equal(shell.status, 0);
  const lines = shell.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const [name, projectPath] = line.split('\t');
    assert.ok(name && projectPath, 'name 与 path 以 TAB 分隔');
  }
});

test('--plan 越界拒绝：非整数/超限报错不猜', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha']);
  assert.notEqual(runKs(['route', '--plan', 'abc', '--home', home]).status, 0);
  assert.notEqual(runKs(['route', '--plan', '21', '--home', home]).status, 0);
});

test('capture --batch 离线队列重放：创建→幂等重放→坏条目不连坐', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', join(home, 'sparks')]).status, 0);
  const queue = join(home, 'queue.json');
  writeFileSync(queue, JSON.stringify([
    { title: '排队火花一', text: '断网时想到的 A' },
    { title: '排队火花二', text: '断网时想到的 B', source: 'mail' },
  ]), 'utf8');

  const first = JSON.parse(runKs(['spark', 'capture', '--batch', queue, '--home', home]).stdout);
  assert.equal(first.created, 2);
  assert.equal(first.failed, 0);

  // 重放幂等：同队列再来一遍全部 skipped-exists（回放到一半断线可安全重试）
  const replay = JSON.parse(runKs(['spark', 'capture', '--batch', queue, '--home', home]).stdout);
  assert.equal(replay.created, 0);
  assert.equal(replay.skipped, 2);
  assert.equal(replay.failed, 0);
  assert.equal(replay.entries.every((e) => e.status === 'skipped-exists'), true);

  // 坏条目不连坐：一条畸形，好条目照入、failed 点名
  const dirty = join(home, 'queue-dirty.json');
  writeFileSync(dirty, JSON.stringify([
    { title: '好条目', text: '内容正常' },
    { title: 42 },
  ]), 'utf8');
  const mixed = runKs(['spark', 'capture', '--batch', dirty, '--home', home]);
  assert.equal(mixed.status, 1, '有失败条目退出码非零（回放方知道要重试）');
  const mixedReport = JSON.parse(mixed.stdout);
  assert.equal(mixedReport.created, 1);
  assert.equal(mixedReport.failed, 1);

  // 入库的火花 source 随行（回桌面 spark list 可回溯）
  const list = JSON.parse(runKs(['spark', 'list', '--home', home]).stdout);
  const sources = new Map(list.sparks.map((s) => [s.title, s.source]));
  assert.equal(sources.get('排队火花一'), 'im', '缺 source 的条目吃 --source 回退默认');
  assert.equal(sources.get('排队火花二'), 'mail');
});

test('capture --batch 坏队列文件零写入拒绝', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', join(home, 'sparks')]).status, 0);
  const bad = join(home, 'bad.json');
  writeFileSync(bad, 'not-json{{', 'utf8');
  const result = runKs(['spark', 'capture', '--batch', bad, '--home', home]);
  assert.notEqual(result.status, 0);
  const list = JSON.parse(runKs(['spark', 'list', '--home', home]).stdout);
  assert.equal(list.sparks.length, 0, '队列不认则一个都不写');
});

test('离线配方在纸：docs/mobile-shell.md 覆盖缓存计划与队列重放，边界如实', () => {
  const doc = readFileSync(join(__dirname, '..', 'docs', 'mobile-shell.md'), 'utf8');
  assert.match(doc, /route --plan/);
  assert.match(doc, /capture --batch/);
  assert.match(doc, /generatedAt/);
  assert.match(doc, /仍是后续题/, '通知/widget 仍是后续题不吹成完成');
});
