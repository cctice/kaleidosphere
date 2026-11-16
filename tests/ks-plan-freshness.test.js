// tests/ks-plan-freshness.test.js — 缓存计划新鲜度（维护心跳包·十三轮）：
// 壳把 --plan 同步进快捷指令变量断网照读——多老算陈旧、桌面离线期是否真转过，
// 此前都要壳侧人算。现在 ks 权威判定：--plan 生成时落 state/plan-cache.json，
// --plan --status 回真话（fresh/stale/mismatch 三态），壳不算新鲜度。
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function setupProjects(home, names) {
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  for (const name of names) {
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']).status, 0);
  }
}

test('--plan 生成即落 state/plan-cache.json（壳同步这份，planId/staleAfterHours 随行）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma']);
  const plan = JSON.parse(runKs(['route', '--plan', '3', '--home', home]).stdout);
  assert.match(plan.planId, /^[0-9a-f]{16}$/, '步骤序列+水位指纹');
  assert.equal(plan.staleAfterHours, 24, '陈旧阈值随行（KS_PLAN_STALE_HOURS 默认 24）');
  const cache = JSON.parse(readFileSync(join(home, 'state', 'plan-cache.json'), 'utf8'));
  assert.equal(cache.planId, plan.planId);
  assert.equal(cache.plan.length, 3);
  assert.equal(existsSync(join(home, 'state', 'rotation.json')), false, '仍不碰 rotation 记档');
});

test('--status fresh：刚生成的缓存，age 未超阈值且 planId 仍匹配', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);
  runKs(['route', '--plan', '2', '--home', home]);
  const status = JSON.parse(runKs(['route', '--plan', '--status', '--home', home]).stdout);
  assert.equal(status.cached, true);
  assert.equal(status.verdict, 'fresh');
  assert.equal(status.planIdMatches, true);
  assert.equal(status.stale, false);
  assert.match(status.hint, /safe to use offline/);
});

test('--status mismatch：离线期桌面真转过（rotation 前进），planId 不匹配如实点名', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta', 'gamma']);
  runKs(['route', '--plan', '3', '--home', home]);
  assert.equal(runKs(['route', '--home', home]).status, 0); // 真转一步
  const status = JSON.parse(runKs(['route', '--plan', '--status', '--home', home]).stdout);
  assert.equal(status.planIdMatches, false);
  assert.equal(status.verdict, 'mismatch');
  assert.match(status.hint, /re-sync/);
});

test('--status stale：age 超阈值（默认 24h）点名陈旧，KS_PLAN_STALE_HOURS=0 关闭判定', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);
  runKs(['route', '--plan', '2', '--home', home]);
  const cachePath = join(home, 'state', 'plan-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  cache.generatedAt = new Date(Date.now() - 25 * 3600000).toISOString(); // 25h 前
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  const status = JSON.parse(runKs(['route', '--plan', '--status', '--home', home]).stdout);
  assert.equal(status.stale, true);
  assert.equal(status.verdict, 'stale', '陈旧优先级低于 mismatch，但 planId 仍匹配时如实 stale');
  assert.ok(status.ageHours >= 25);

  const off = JSON.parse(runKs(['route', '--plan', '--status', '--home', home], { KS_PLAN_STALE_HOURS: '0' }).stdout);
  assert.equal(off.stale, false, '阈值 0=关闭陈旧判定（内容口径仍由 planIdMatches 看守）');
  assert.equal(off.staleAfterHours, 0);
});

test('--status 无缓存：如实 cached=false 并指路，不装懂', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha']);
  const status = JSON.parse(runKs(['route', '--plan', '--status', '--home', home]).stdout);
  assert.equal(status.cached, false);
  assert.match(status.hint, /ks route --plan/);
});
