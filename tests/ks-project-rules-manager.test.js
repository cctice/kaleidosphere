const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function createWorksite() {
  const home = mkdtempSync(join(tmpdir(), 'ks-rules-home-'));
  const workspace = join(home, 'work');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const created = JSON.parse(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'rules-project', '--json']).stdout);
  const agents = join(created.project.path, created.project.name, 'AGENTS.md');
  writeFileSync(agents, '# Agent rules\n');
  return { home, project: created.project, agents };
}

test('ks project rules propose and apply use a saved plan and atomically inject an existing agent rule file', () => {
  const { home, project, agents } = createWorksite();
  const proposed = JSON.parse(runKs([
    'project', 'rules', 'propose', '--home', home, '--id', project.id,
    '--rule', 'cli-runtime', '--title', 'CLI runtime', '--text', 'Use ks through the packaged runtime.', '--json'
  ]).stdout);
  assert.equal(proposed.applied, false);
  assert.equal(readFileSync(agents, 'utf8').includes('ks:project-rules:start'), false);

  const applied = runKs(['project', 'rules', 'apply', '--home', home, '--plan', proposed.plan.id, '--apply', '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  const rules = readFileSync(join(project.path, 'ks-context', 'project-rules.md'), 'utf8');
  assert.match(rules, /## Rule: cli-runtime/);
  assert.match(readFileSync(agents, 'utf8'), /ks:project-rules:start/);
  const checked = JSON.parse(runKs(['project', 'rules', 'check', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(checked.compliant, true);
});

test('ks project rules remove requires a second plan and removes the atomic reference when no rules remain', () => {
  const { home, project, agents } = createWorksite();
  const add = JSON.parse(runKs([
    'project', 'rules', 'propose', '--home', home, '--id', project.id,
    '--rule', 'git', '--text', 'Do not rewrite user history.', '--json'
  ]).stdout);
  assert.equal(runKs(['project', 'rules', 'apply', '--home', home, '--plan', add.plan.id, '--apply', '--json']).status, 0);
  const remove = JSON.parse(runKs(['project', 'rules', 'remove', '--home', home, '--id', project.id, '--rule', 'git', '--json']).stdout);
  assert.equal(runKs(['project', 'rules', 'apply', '--home', home, '--plan', remove.plan.id, '--apply', '--json']).status, 0);
  assert.doesNotMatch(readFileSync(agents, 'utf8'), /ks:project-rules:start/);
});
