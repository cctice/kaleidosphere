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

function createWorksite() {
  const home = mkdtempSync(join(tmpdir(), 'ks-version-home-'));
  const workspace = join(home, 'tooling');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'tooling', '--path', workspace, '--json']).status, 0);
  const created = JSON.parse(runKs(['project', 'create', '--home', home, '--workspace', 'tooling', '--name', 'versioned-project', '--json']).stdout);
  const agents = join(created.project.path, created.project.name, 'AGENTS.md');
  writeFileSync(agents, '# Agent rules\n');
  return { home, project: created.project, agents };
}

test('ks version init creates a reviewable plan and apply manages a unified version', () => {
  const { home, project, agents } = createWorksite();
  const initial = JSON.parse(runKs(['version', 'status', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(initial.state, 'needs_user_decision');

  const planned = JSON.parse(runKs(['version', 'init', '--home', home, '--id', project.id, '--version', '0.1.0', '--json']).stdout);
  assert.equal(planned.applied, false);
  assert.equal(planned.plan.type, 'version-init');
  assert.equal(existsSync(join(project.path, 'ks-context', 'versioning.yaml')), false);

  const applied = runKs(['version', 'apply', '--home', home, '--plan', planned.plan.id, '--apply', '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.status.state, 'managed');
  assert.equal(result.status.config.mode, 'unified');
  assert.equal(result.status.config.components[0].version, '0.1.0');
  assert.match(readFileSync(agents, 'utf8'), /ks:versioning:start/);

  const checked = JSON.parse(runKs(['version', 'check', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(checked.compliant, true);
});

test('ks version plan changes an existing component only after its saved plan is applied', () => {
  const { home, project } = createWorksite();
  const initialized = JSON.parse(runKs(['version', 'init', '--home', home, '--id', project.id, '--version', '0.1.0', '--json']).stdout);
  assert.equal(runKs(['version', 'apply', '--home', home, '--plan', initialized.plan.id, '--apply', '--json']).status, 0);

  const plan = JSON.parse(runKs(['version', 'plan', '--home', home, '--id', project.id, '--component', 'project', '--set', '0.2.0', '--json']).stdout);
  const before = JSON.parse(readFileSync(join(project.path, 'ks-context', 'versioning.yaml'), 'utf8'));
  assert.equal(before.components[0].version, '0.1.0');
  assert.equal(runKs(['version', 'apply', '--home', home, '--plan', plan.plan.id, '--apply', '--json']).status, 0);
  const after = JSON.parse(readFileSync(join(project.path, 'ks-context', 'versioning.yaml'), 'utf8'));
  assert.equal(after.components[0].version, '0.2.0');
});

test('ks version plan can record that a project does not use KS version management', () => {
  const { home, project } = createWorksite();
  const plan = JSON.parse(runKs(['version', 'plan', '--home', home, '--id', project.id, '--disable', '--json']).stdout);
  assert.equal(plan.plan.type, 'version-disable');
  assert.equal(runKs(['version', 'apply', '--home', home, '--plan', plan.plan.id, '--apply', '--json']).status, 0);
  const status = JSON.parse(runKs(['version', 'status', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(status.state, 'unmanaged');
  const checked = JSON.parse(runKs(['version', 'check', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(checked.compliant, true);
});
