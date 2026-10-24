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

function createProject() {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'personal');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'personal', '--path', workspace, '--json']).status, 0);
  const result = runKs(['project', 'create', '--home', home, '--workspace', 'personal', '--name', 'creative-system', '--json']);
  assert.equal(result.status, 0, result.stderr);
  return { home, project: JSON.parse(result.stdout).project };
}

test('ks project metadata supports tags, aliases, a summary, lifecycle, and semantic search', () => {
  const { home, project } = createProject();
  assert.deepEqual(project.tags, []);
  assert.deepEqual(project.aliases, []);
  assert.equal(project.summary, null);
  assert.equal(project.lifecycle, 'active');

  const addTag = runKs(['project', 'tag', 'add', '--home', home, '--id', project.id, '--tag', 'efficiency', '--json']);
  assert.equal(addTag.status, 0, addTag.stderr);
  assert.deepEqual(JSON.parse(addTag.stdout).project.tags, ['efficiency']);
  const addSecondTag = runKs(['project', 'tag', 'add', '--home', home, '--id', project.id, '--tag', 'creative-production', '--json']);
  assert.equal(addSecondTag.status, 0, addSecondTag.stderr);

  const addAlias = runKs(['project', 'alias', 'add', '--home', home, '--id', project.id, '--alias', '创意生产系统', '--json']);
  assert.equal(addAlias.status, 0, addAlias.stderr);
  const describe = runKs(['project', 'describe', '--home', home, '--id', project.id, '--summary', '个人维护的 AI 创意提效系统', '--json']);
  assert.equal(describe.status, 0, describe.stderr);
  const lifecycle = runKs(['project', 'lifecycle', 'set', '--home', home, '--id', project.id, '--state', 'paused', '--json']);
  assert.equal(lifecycle.status, 0, lifecycle.stderr);

  const inspected = runKs(['project', 'inspect', '--home', home, '--id', project.id, '--json']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout).project.tags, ['efficiency', 'creative-production']);
  assert.deepEqual(JSON.parse(inspected.stdout).project.aliases, ['创意生产系统']);
  assert.equal(JSON.parse(inspected.stdout).project.summary, '个人维护的 AI 创意提效系统');
  assert.equal(JSON.parse(inspected.stdout).project.lifecycle, 'paused');

  const tagged = runKs(['project', 'list', '--home', home, '--tag', 'efficiency', '--json']);
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.equal(JSON.parse(tagged.stdout).projects.length, 1);
  const searched = runKs(['project', 'search', '--home', home, '--query', '创意生产', '--json']);
  assert.equal(searched.status, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).projects[0].id, project.id);
});

test('ks project metadata validates tags and lifecycle values', () => {
  const { home, project } = createProject();
  const invalidTag = runKs(['project', 'tag', 'add', '--home', home, '--id', project.id, '--tag', 'Not Valid', '--json']);
  assert.equal(invalidTag.status, 1);
  assert.match(invalidTag.stderr, /lowercase kebab-case/);
  const invalidState = runKs(['project', 'lifecycle', 'set', '--home', home, '--id', project.id, '--state', 'deleted', '--json']);
  assert.equal(invalidState.status, 1);
  assert.match(invalidState.stderr, /active, paused, or archived/);
});
