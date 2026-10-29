// tests/ks-registry-share.test.js — registry 共享形态（维护心跳包·九轮：单机 json → 多工作区/团队共享）
//
// 链路：A 机 export bundle → B 机 import 合流。按 id 三态：新 id 入册、同 id 同容跳过、
// 同 id 漂移点名不静默覆盖（--force 才让来客赢）——共享不等于互踩。
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupHome(name, projects) {
  const home = mkdtempSync(join(tmpdir(), `ks-${name}-`));
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  for (const project of projects) {
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', project, '--json']).status, 0);
  }
  return home;
}

test('export：自包含 bundle（schema/workspaces/projects），未 init 拒绝', () => {
  const home = setupHome('exp', ['alpha', 'beta']);
  const exported = JSON.parse(runKs(['registry', 'export', '--home', home]).stdout);
  assert.equal(exported.ok, true);
  assert.equal(exported.schema, 1);
  assert.equal(exported.projects.length, 2);
  assert.equal(exported.workspaces.length, 1);
  assert.ok(exported.workspaces.some((w) => w.id === 'work'), '项目引用的 workspace 随 bundle 走（自包含）');

  const bare = mkdtempSync(join(tmpdir(), 'ks-bare-'));
  const refused = runKs(['registry', 'export', '--home', bare]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /run ks init first/);
});

test('import 合流：新 id 入册、同 id 同容跳过（重放幂等）', () => {
  const homeA = setupHome('share-a', ['alpha', 'beta']);
  const homeB = setupHome('share-b', ['gamma']);
  const bundlePath = join(homeB, 'bundle.json');
  writeFileSync(bundlePath, runKs(['registry', 'export', '--home', homeA]).stdout);

  const merged = JSON.parse(runKs(['registry', 'import', '--home', homeB, '--file', bundlePath]).stdout);
  assert.equal(merged.ok, true);
  assert.equal(merged.projects.added.length, 2, 'A 机两项目入册');
  const listed = JSON.parse(runKs(['project', 'list', '--home', homeB]).stdout);
  const names = listed.projects.map((p) => p.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', 'gamma'], 'B 机拿到 A 机全部项目，自己的 gamma 不丢');

  // 重放同一 bundle：全部 skip，幂等
  const replay = JSON.parse(runKs(['registry', 'import', '--home', homeB, '--file', bundlePath]).stdout);
  assert.equal(replay.changed, false);
  assert.equal(replay.projects.skipped.length, 2);
});

test('同 id 漂移：点名冲突不静默覆盖，本地版本纹丝不动；--force 才让来客赢（且不夺本地 path）', () => {
  const homeB = setupHome('share-d', ['alpha']);
  const bundlePath = join(homeB, 'bundle2.json');
  // 团队真实场景：项目 id 来自早前同步（同 id），A 机随后改了 summary——漂移导入
  const local = JSON.parse(runKs(['project', 'list', '--home', homeB]).stdout).projects[0];
  const drifted = {
    schema: 1,
    workspaces: [{ id: 'work', path: '/elsewhere/on/a', createdAt: local.createdAt }],
    projects: [{ ...local, summary: 'A 机版本' }]
  };
  writeFileSync(bundlePath, JSON.stringify(drifted));

  const conflict = runKs(['registry', 'import', '--home', homeB, '--file', bundlePath]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicting ids without --force/);
  // workspace path 是机器本地字段：同 id 不同 path 不构成冲突（共享常态）
  const kept = JSON.parse(runKs(['project', 'list', '--home', homeB]).stdout);
  assert.equal(kept.projects[0].summary, null, '本地版本未被静默覆盖');

  const forced = JSON.parse(runKs(['registry', 'import', '--home', homeB, '--file', bundlePath, '--force']).stdout);
  assert.ok(forced.projects.overwritten.length >= 1, '--force 让来客赢并如实记 overwritten');
  const after = JSON.parse(runKs(['project', 'list', '--home', homeB]).stdout);
  assert.equal(after.projects[0].summary, 'A 机版本');
});

test('坏 bundle 如实拒绝：schema 不认/缺字段/非 JSON，registry 纹丝不动', () => {
  const home = setupHome('share-e', ['alpha']);
  const before = readFileSync(join(home, 'registry', 'projects.json'), 'utf8');
  const badDir = mkdtempSync(join(tmpdir(), 'ks-bad-'));
  const cases = [
    ['bad-schema.json', JSON.stringify({ schema: 99, projects: [], workspaces: [] })],
    ['bad-shape.json', JSON.stringify({ schema: 1, projects: [] })],
    ['bad-json.json', '{not json'],
  ];
  for (const [name, content] of cases) {
    const file = join(badDir, name);
    writeFileSync(file, content);
    const refused = runKs(['registry', 'import', '--home', home, '--file', file]);
    assert.equal(refused.status, 1, name);
  }
  assert.equal(readFileSync(join(home, 'registry', 'projects.json'), 'utf8'), before, '拒绝路径零写入');
});
