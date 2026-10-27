const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'ks-update-home-'));
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  return home;
}

function createWorksiteProject(home, name = 'alpha') {
  const workspace = join(home, 'work');
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const created = runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', name, '--json']);
  assert.equal(created.status, 0, created.stderr);
  return JSON.parse(created.stdout).project;
}

test('ks project update renames a registered project and rejects invalid updates', () => {
  const home = createHome();
  const workspace = join(home, 'work');
  const repositoryPath = join(workspace, 'direct-repo');
  mkdirSync(repositoryPath, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: repositoryPath, encoding: 'utf8' }).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const registered = runKs(['project', 'register', '--home', home, '--workspace', 'work', '--name', 'direct-repo', '--path', repositoryPath, '--json']);
  assert.equal(registered.status, 0, registered.stderr);
  const project = JSON.parse(registered.stdout).project;

  const noFields = runKs(['project', 'update', '--home', home, '--id', project.id, '--json']);
  assert.equal(noFields.status, 1);
  assert.match(noFields.stderr, /requires at least one of --name, --workspace, --path, or --layout/);

  const invalidName = runKs(['project', 'update', '--home', home, '--id', project.id, '--name', 'Not Valid', '--json']);
  assert.equal(invalidName.status, 1);
  assert.match(invalidName.stderr, /--name must use lowercase kebab-case/);

  const invalidLayout = runKs(['project', 'update', '--home', home, '--id', project.id, '--layout', 'hybrid', '--json']);
  assert.equal(invalidLayout.status, 1);
  assert.match(invalidLayout.stderr, /--layout must be direct or worksite/);

  const renamed = runKs(['project', 'update', '--home', home, '--id', project.id, '--name', 'renamed-repo', '--json']);
  assert.equal(renamed.status, 0, renamed.stderr);
  const updated = JSON.parse(renamed.stdout).project;
  assert.equal(updated.name, 'renamed-repo');
  assert.equal(updated.path, repositoryPath);

  const inspected = JSON.parse(runKs(['project', 'inspect', '--home', home, '--id', project.id, '--json']).stdout);
  assert.equal(inspected.project.name, 'renamed-repo');
});

test('ks project tag remove and tag list manage the tag set end to end', () => {
  const home = createHome();
  const project = createWorksiteProject(home);
  assert.equal(runKs(['project', 'tag', 'add', '--home', home, '--id', project.id, '--tag', 'efficiency', '--json']).status, 0);
  assert.equal(runKs(['project', 'tag', 'add', '--home', home, '--id', project.id, '--tag', 'creative-production', '--json']).status, 0);

  const listed = runKs(['project', 'tag', 'list', '--home', home, '--id', project.id, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const tags = JSON.parse(listed.stdout);
  assert.equal(tags.projectId, project.id);
  assert.deepEqual(tags.tags, ['efficiency', 'creative-production']);

  const removed = runKs(['project', 'tag', 'remove', '--home', home, '--id', project.id, '--tag', 'efficiency', '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).project.tags, ['creative-production']);

  const filtered = JSON.parse(runKs(['project', 'list', '--home', home, '--tag', 'efficiency', '--json']).stdout);
  assert.equal(filtered.projects.length, 0);
  const remaining = JSON.parse(runKs(['project', 'list', '--home', home, '--tag', 'creative-production', '--json']).stdout);
  assert.equal(remaining.projects.length, 1);
});

test('ks project alias remove and alias list manage the alias set end to end', () => {
  const home = createHome();
  const project = createWorksiteProject(home);
  assert.equal(runKs(['project', 'alias', 'add', '--home', home, '--id', project.id, '--alias', '创意生产系统', '--json']).status, 0);
  assert.equal(runKs(['project', 'alias', 'add', '--home', home, '--id', project.id, '--alias', 'creative-system', '--json']).status, 0);

  const listed = runKs(['project', 'alias', 'list', '--home', home, '--id', project.id, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const aliases = JSON.parse(listed.stdout);
  assert.equal(aliases.projectId, project.id);
  assert.deepEqual(aliases.aliases, ['创意生产系统', 'creative-system']);

  const removed = runKs(['project', 'alias', 'remove', '--home', home, '--id', project.id, '--alias', '创意生产系统', '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).project.aliases, ['creative-system']);

  const searched = JSON.parse(runKs(['project', 'search', '--home', home, '--query', '创意生产', '--json']).stdout);
  assert.equal(searched.projects.length, 0);
});

test('ks workspace list enumerates every registered workspace', () => {
  const home = createHome();
  const work = join(home, 'work');
  const personal = join(home, 'personal');
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', work, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'personal', '--path', personal, '--json']).status, 0);

  const listed = runKs(['workspace', 'list', '--home', home, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const workspaces = JSON.parse(listed.stdout).workspaces;
  assert.deepEqual(workspaces.map((item) => item.id).sort(), ['personal', 'work']);
  assert.deepEqual(workspaces.map((item) => item.mode), ['managed', 'managed']);
});

test('ks project resolve maps nested and repository paths to the owning project', () => {
  const home = createHome();
  const project = createWorksiteProject(home, 'resolvable');

  const resolved = runKs(['project', 'resolve', '--home', home, '--path', join(project.path, 'resolvable'), '--json']);
  assert.equal(resolved.status, 0, resolved.stderr);
  const result = JSON.parse(resolved.stdout);
  assert.equal(result.project.id, project.id);
  assert.equal(result.repoPath, join(project.path, 'resolvable'));

  const nested = runKs(['project', 'resolve', '--home', home, '--path', join(project.path, 'resolvable', 'src', 'main.js'), '--json']);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(JSON.parse(nested.stdout).project.id, project.id);

  const unknown = runKs(['project', 'resolve', '--home', home, '--path', join(home, 'nowhere'), '--json']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no registered project contains path/);
});
