// tests/ks-route.test.js — 转动路由（维护包四轮：多项目轮转的最短路径）
//
// 痛点：多项目/多工作流"转动路由"缺快捷入口。ks route 以 least-recently-routed
// 选择在活跃项目间转动：反复调用自动轮转，一周期内不重复；状态记档可追溯；
// 单短命令形态为快捷键别名与移动端壳复用同一入口。
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

function setupProjects(home, names) {
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  const ids = [];
  for (const name of names) {
    const created = JSON.parse(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']).stdout);
    ids.push(created.project.id);
  }
  return ids;
}

test('ks route 在活跃项目间轮转：一周期内不重复，状态记档', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma']);

  const visited = [];
  for (let i = 0; i < 3; i += 1) {
    const routed = JSON.parse(runKs(['route', '--home', home]).stdout);
    assert.equal(routed.ok, true);
    visited.push(routed.project.name);
    assert.ok(routed.upcoming.length > 0, '多候选时必须预告下一批');
  }
  assert.equal(new Set(visited).size, 3, '一个周期内不得重复路由同一项目');
  assert.deepEqual([...visited].sort(), ['alpha', 'beta', 'gamma']);

  const rotation = JSON.parse(readFileSync(join(home, 'state', 'rotation.json'), 'utf8'));
  assert.equal(rotation.history.length, 3, '转动历史必须落 state/rotation.json');
});

test('ks route 尊重 tag 过滤与 lifecycle，空候选如实报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const [alphaId, betaId] = setupProjects(home, ['alpha', 'beta']);
  assert.equal(runKs(['project', 'tag', 'add', '--home', home, '--id', alphaId, '--tag', 'focus', '--json']).status, 0);
  assert.equal(runKs(['project', 'lifecycle', 'set', '--home', home, '--id', betaId, '--state', 'paused', '--json']).status, 0);

  const routed = JSON.parse(runKs(['route', '--home', home, '--tag', 'focus']).stdout);
  assert.equal(routed.project.name, 'alpha');

  const pausedRoute = runKs(['route', '--home', home, '--lifecycle', 'archived']);
  assert.equal(pausedRoute.status, 1);
  assert.match(pausedRoute.stderr, /no archived projects to route to/);

  assert.equal(runKs(['project', 'lifecycle', 'set', '--home', home, '--id', alphaId, '--state', 'paused', '--json']).status, 0);
  const noneActive = runKs(['route', '--home', home]);
  assert.equal(noneActive.status, 1);
  assert.match(noneActive.stderr, /no active projects to route to/);
});
