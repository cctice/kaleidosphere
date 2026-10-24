const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('ks project register records an existing direct Git repository and project list returns it', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'tooling');
  const project = join(workspace, 'existing-project');
  mkdirSync(project, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.equal(run(['init', '--home', home, '--json']).status, 0);
  assert.equal(run(['workspace', 'add', '--home', home, '--id', 'tooling', '--path', workspace, '--json']).status, 0);
  const registered = run(['project', 'register', '--home', home, '--workspace', 'tooling', '--name', 'existing-project', '--path', project, '--layout', 'direct', '--json']);
  assert.equal(registered.status, 0, registered.stderr);
  const listed = run(['project', 'list', '--home', home, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).projects[0].path, project);
  assert.equal(JSON.parse(listed.stdout).projects[0].layout, 'direct');
  const checked = JSON.parse(run(['project', 'check', '--home', home, '--id', JSON.parse(registered.stdout).project.id, '--json']).stdout);
  assert.equal(checked.compliant, false);
  assert.equal(checked.checks.find((check) => check.id === 'layout.worksite').passed, false);
});

test('ks project update corrects an existing project registration without moving the repository', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'tooling');
  const project = join(workspace, 'kaleidosphere');
  mkdirSync(project, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.equal(run(['init', '--home', home, '--json']).status, 0);
  assert.equal(run(['workspace', 'add', '--home', home, '--id', 'tooling', '--path', workspace, '--json']).status, 0);
  const registered = JSON.parse(run([
    'project', 'register', '--home', home, '--workspace', 'tooling', '--name', 'kaleido-sphere', '--path', project, '--layout', 'direct', '--json'
  ]).stdout);

  const updated = run([
    'project', 'update', '--home', home, '--id', registered.project.id, '--name', 'kaleidosphere', '--path', project, '--json'
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const result = JSON.parse(updated.stdout);
  assert.equal(result.project.name, 'kaleidosphere');
  assert.equal(result.project.path, project);
  assert.equal(result.project.layout, 'direct');
  assert.equal(result.project.id, registered.project.id);
});

test('ks project update can repair a migrated development worksite registration only when the worksite is complete', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'tooling');
  const project = join(workspace, 'kaleidosphere-proj');
  const repo = join(project, 'kaleidosphere');
  mkdirSync(join(project, 'ks-context'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  require('node:fs').writeFileSync(join(project, 'ks-context', 'project.json'), JSON.stringify({}));
  assert.equal(run(['init', '--home', home, '--json']).status, 0);
  assert.equal(run(['workspace', 'add', '--home', home, '--id', 'tooling', '--path', workspace, '--json']).status, 0);
  const registered = JSON.parse(run([
    'project', 'register', '--home', home, '--workspace', 'tooling', '--name', 'kaleidosphere', '--path', project, '--layout', 'direct', '--json'
  ]).stdout);

  const updated = run([
    'project', 'update', '--home', home, '--id', registered.project.id, '--layout', 'worksite', '--json'
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).project.layout, 'worksite');
});
