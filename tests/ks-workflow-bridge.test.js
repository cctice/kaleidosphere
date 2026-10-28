// tests/ks-workflow-bridge.test.js — workflow 桥接门（维护包四轮：P1 深集成）
//
// afk 不再停留在与 ks 数据隔离的 bundled 内置形态：ks workflow run 产出
// 指向 plugins/afk 的一次性 handoff 提示（不自动开流），并把 registry 项目
// 元数据随行注入。桥的每一项声称都有断言背书。
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupProject(home) {
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace]).status, 0);
  const created = JSON.parse(runKs([
    'project', 'create', '--home', home, '--workspace', 'work', '--name', 'demo-app',
    '--summary', 'Demo project for the workflow bridge', '--tag', 'demo', '--json'
  ]).stdout);
  return created.project;
}

test('ks workflow run 注入 ks 项目数据并指向 bundled afk 引擎（一次性 handoff）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const project = setupProject(home);

  const run = JSON.parse(runKs([
    'workflow', 'run', '--home', home, '--project-id', project.id, '--task', '修复导入失败缺陷'
  ]).stdout);

  assert.equal(run.autoStart, false, '不自动开流（blueprint 约束）');
  assert.equal(run.handoff, 'one-shot');
  assert.equal(run.engine.name, 'afk');
  assert.equal(run.engine.skill, 'afk-flow');
  assert.ok(existsSync(run.skillEntry), 'handoff 指向的 afk-flow SKILL.md 必须真实存在');
  assert.equal(run.context.project.name, 'demo-app');
  assert.equal(run.context.project.summary, 'Demo project for the workflow bridge');
  assert.deepEqual(run.context.project.tags, ['demo']);
  assert.equal(run.context.task, '修复导入失败缺陷');
  assert.match(run.prompt, /afk-flow/);
  assert.match(run.prompt, /Demo project for the workflow bridge/);
  assert.match(run.prompt, /修复导入失败缺陷/);
});

test('ks workflow run 负例：缺 --task / 项目不存在 / 空任务', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const project = setupProject(home);

  const missingTask = runKs(['workflow', 'run', '--home', home, '--project-id', project.id]);
  assert.equal(missingTask.status, 1);
  assert.match(missingTask.stderr, /--task requires a value/);

  const emptyTask = runKs(['workflow', 'run', '--home', home, '--project-id', project.id, '--task', '  ']);
  assert.equal(emptyTask.status, 1);
  assert.match(emptyTask.stderr, /must not be empty/);

  const unknownProject = runKs(['workflow', 'run', '--home', home, '--project-id', 'prj_missing', '--task', 'x']);
  assert.equal(unknownProject.status, 1);
  assert.match(unknownProject.stderr, /project does not exist/);
});
