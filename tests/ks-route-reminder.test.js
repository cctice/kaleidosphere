// tests/ks-route-reminder.test.js — 转动提醒闭环门（维护包八轮）
//
// 痛点：route/rotation 依赖手动调用，"该转下一块玻璃时没人喊"。本轮 ks status
// 从 rotation.json 真源读停转时长，超阈值即 reminders 点名 ks route：
//   ① 多活跃项目+从未转动 → due 如实（idleDays=null 不是 0 天，是"从没转过"）；
//   ② 刚转过（history 新鲜）→ due=false，不打扰；
//   ③ 停转超阈值 → reminders 带原因点名（活跃数/停转天数/阈值全在话术里）；
//   ④ KS_ROUTE_REMIND_DAYS=0 关闭提醒（back-compat 口子）；
//   ⑤ 单活跃项目不提醒（一块玻璃没有"下一块"）。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
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
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name]).status, 0);
  }
}

function seedRotation(home, idleDays) {
  mkdirSync(join(home, 'state'), { recursive: true });
  const routedAt = idleDays === null ? null : new Date(Date.now() - idleDays * 86_400_000).toISOString();
  writeFileSync(
    join(home, 'state', 'rotation.json'),
    JSON.stringify({ schemaVersion: 1, history: routedAt ? [{ projectId: 'p1', routedAt }] : [] })
  );
}

const status = (home, env) => JSON.parse(runKs(['status', '--home', home], env).stdout);

test('多活跃项目+从未转动 → due 如实（idleDays=null 是"从没转过"，不是 0 天）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);
  seedRotation(home, null);
  const result = status(home);
  assert.equal(result.rotation.due, true);
  assert.equal(result.rotation.idleDays, null);
  assert.equal(result.rotation.activeProjects, 2);
  assert.ok(result.reminders.some((reminder) => reminder.command === 'ks route' && reminder.why.includes('从未转动')));
});

test('刚转过（history 新鲜）→ due=false 不打扰；停转超阈值 → 点名带全量原因', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);

  seedRotation(home, 0);
  assert.equal(status(home).rotation.due, false, '当天转过的别喊');

  seedRotation(home, 5);
  const due = status(home);
  assert.equal(due.rotation.due, true);
  assert.equal(due.rotation.idleDays, 5);
  const reminder = due.reminders.find((item) => item.command === 'ks route');
  assert.ok(reminder.why.includes('5 天'), '停转天数在话术里');
  assert.ok(reminder.why.includes('3 天'), '阈值在话术里（默认 3）');
});

test('KS_ROUTE_REMIND_DAYS=0 关闭提醒；单活跃项目没有"下一块玻璃"不提醒', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);
  seedRotation(home, 30);
  const off = status(home, { KS_ROUTE_REMIND_DAYS: '0' });
  assert.equal(off.rotation.due, false, '阈值 0 = 关闭');
  assert.deepEqual(off.reminders, []);

  const solo = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(solo, ['only']);
  seedRotation(solo, null);
  assert.equal(status(solo).rotation.due, false, '单活跃项目不提醒');
});
