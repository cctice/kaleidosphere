// tests/ks-state-lock.test.js — 本地状态文件并发写保护门（维护包六轮）
//
// 痛点：state/rotation.json 读-改-写无并发保护，多会话同跑 ks route 会互踩
// （丢转动记录/覆盖写）。本轮上独占锁：活锁有限重试后如实报 busy、
// 陈锁（崩溃残留）超龄自动接管、正常路径透明无感。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function homeWithProjects() {
  const home = mkdtempSync(join(tmpdir(), 'ks-lock-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0, 'init 失败');
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', join(home, 'work')]).status, 0, 'workspace add 失败');
  const created = runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'lock-demo', '--json']);
  assert.equal(created.status, 0, `project create 失败: ${created.stderr}`);
  return home;
}

test('ks route 正常路径透明加锁，跑完锁即释放', () => {
  const home = homeWithProjects();
  const run = runKs(['route', '--home', home]);
  assert.equal(run.status, 0, `route 失败: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.project.name, 'lock-demo');
  assert.equal(existsSync(join(home, 'state', 'rotation.lock')), false, '跑完必须释放锁，不留残留');
});

test('活锁让位：他人在持锁时有限重试后如实报 busy，不静默互踩', () => {
  const home = homeWithProjects();
  const lockPath = join(home, 'state', 'rotation.lock');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(lockPath, String(process.pid)); // 模拟另一会话持锁（新鲜 mtime）
  const run = runKs(['route', '--home', home], { KS_STATE_LOCK_TIMEOUT_MS: '150' });
  assert.equal(run.status, 1, '持锁未释放时不得硬闯');
  assert.match(run.stderr, /rotation is busy/);
  assert.equal(existsSync(lockPath), true, '他人的活锁不许被误删');
});

test('陈锁接管：崩溃残留的超龄锁自动清除，不卡死后续操作', () => {
  const home = homeWithProjects();
  const lockPath = join(home, 'state', 'rotation.lock');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(lockPath, 'ghost');
  const stale = new Date(Date.now() - 60 * 1000); // 60s 前的残留（>30s 陈龄线）
  utimesSync(lockPath, stale, stale);
  const run = runKs(['route', '--home', home]);
  assert.equal(run.status, 0, `陈锁必须被接管而非卡死: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).project.name, 'lock-demo');
  assert.equal(existsSync(lockPath), false, '接管后陈锁清除');
});
