// tests/ks-route-shell.test.js — 移动端壳面（维护心跳包·九轮）：route 为壳留了锚、壳本体零进展。
// 第一步=--shell 单行机面：name<TAB>path 一行输出（快捷指令 Run-script-over-SSH 直接接下一动作），
// 副作用与常规 route 完全同源（转动记档照落，桌面/移动同一状态）。
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
  for (const name of names) {
    assert.equal(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']).status, 0);
  }
}

test('--shell：单行 name<TAB>path，无 JSON 包裹（快捷指令直接消费）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);

  const shell = runKs(['route', '--shell', '--home', home]);
  assert.equal(shell.status, 0);
  const lines = shell.stdout.trim().split('\n');
  assert.equal(lines.length, 1, '必须恰好一行');
  const [name, projectPath] = lines[0].split('\t');
  assert.ok(name && projectPath, 'name 与 path 两字段以 TAB 分隔');
  assert.ok(/^(alpha|beta)$/.test(name), '选中的必须是注册项目');
});

test('--shell 副作用同源：转动记档照落 rotation.json，与常规 route 同一状态面', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupProjects(home, ['alpha', 'beta']);

  const shellOut = runKs(['route', '--shell', '--home', home]).stdout.trim();
  const shellName = shellOut.split('\t')[0];

  const rotation = JSON.parse(readFileSync(join(home, 'state', 'rotation.json'), 'utf8'));
  assert.equal(rotation.history.length, 1, '--shell 也是真转动，不是只读预览');

  // 常规 route 随后转：选中的必须不是壳刚转过的（同一轮转周期）
  const next = JSON.parse(runKs(['route', '--home', home]).stdout);
  assert.notEqual(next.project.name, shellName, '桌面端与壳共享 rotation 状态');
});

test('壳配方在纸：docs/mobile-shell.md 落纸且锚定 --shell 与 spark capture 反向通道', () => {
  const doc = readFileSync(join(__dirname, '..', 'docs', 'mobile-shell.md'), 'utf8');
  assert.match(doc, /route --shell/);
  assert.match(doc, /spark capture/);
  assert.match(doc, /Tailscale/);
  assert.match(doc, /边界（如实）/, '边界要如实写（离线/通知是后续题，不吹成完成）');
});
