// tests/ks-status.test.js — 四大能力支柱状态面板 + 新用户引导动线（维护包四轮）
//
// 痛点：四大能力支柱（项目管理/版本管理/规则沉淀/执行协调）缺统一状态面板
// 与新用户引导。ks status 一屏给出四支柱状态；引导动线按缺口给下一条命令，
// 从未初始化到全就位逐步收敛。
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('未初始化：面板四支柱可见且引导第一步指向 ks init', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const status = JSON.parse(runKs(['status', '--home', home]).stdout);
  assert.equal(status.pillars.length, 4);
  assert.deepEqual(status.pillars.map((pillar) => pillar.id), ['project', 'versioning', 'rules', 'coordination']);
  assert.equal(status.onboarding.complete, false);
  assert.equal(status.onboarding.nextSteps[0].command, 'ks init');
});

test('引导动线随缺口收敛：init→workspace→project 逐级推进', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  assert.equal(runKs(['init', '--home', home]).status, 0);

  const afterInit = JSON.parse(runKs(['status', '--home', home]).stdout);
  assert.ok(afterInit.onboarding.nextSteps.some((step) => step.command.startsWith('ks workspace add')), '缺工作空间时必须引导 workspace add');
  assert.ok(afterInit.onboarding.nextSteps.some((step) => step.command.startsWith('ks spark configure')), '火花目录未配置时必须引导 spark configure');

  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', join(home, 'work')]).status, 0);
  const afterWorkspace = JSON.parse(runKs(['status', '--home', home]).stdout);
  assert.ok(afterWorkspace.onboarding.nextSteps.some((step) => step.command.startsWith('ks project create')), '有工作空间无项目时必须引导 project create');
  assert.ok(!afterWorkspace.onboarding.nextSteps.some((step) => step.command.startsWith('ks workspace add')), '工作空间已登记后不再重复引导');
});

test('支柱指标从真源读数：项目计数/生命周期分布进面板', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  const created = JSON.parse(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'panel-demo', '--json']).stdout);
  assert.equal(runKs(['project', 'lifecycle', 'set', '--home', home, '--id', created.project.id, '--state', 'paused', '--json']).status, 0);

  const status = JSON.parse(runKs(['status', '--home', home]).stdout);
  const projectPillar = status.pillars.find((pillar) => pillar.id === 'project');
  assert.equal(projectPillar.state, 'ready');
  assert.match(projectPillar.summary, /1 workspaces \/ 1 projects（active 0 · paused 1 · archived 0）/);
});
