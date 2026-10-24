const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8'
  });
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('ks project create builds a Git-backed development workspace without tracking the named project repository from the outer Git', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workRoot = join(home, 'projects', 'work');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workRoot, '--json']).status, 0);

  const created = runKs([
    'project',
    'create',
    '--home',
    home,
    '--workspace',
    'work',
    '--name',
    'alpha',
    '--git-name',
    'Test Project Owner',
    '--git-email',
    'test-project-owner@example.com',
    '--json'
  ]);
  assert.equal(created.status, 0, created.stderr);

  const result = JSON.parse(created.stdout);
  const projectPath = join(workRoot, 'alpha-proj');
  assert.equal(result.ok, true);
  assert.equal(result.project.name, 'alpha');
  assert.equal(result.project.workspace, 'work');
  assert.equal(result.project.path, projectPath);
  assert.equal(result.project.layout, 'worksite');
  assert.match(result.project.id, /^prj_[a-f0-9-]+$/);

  assert.equal(existsSync(join(projectPath, '.git')), true);
  assert.equal(existsSync(join(projectPath, 'alpha', '.git')), true);
  assert.equal(existsSync(join(projectPath, 'ks-context', 'project.json')), true);
  assert.match(readFileSync(join(projectPath, '.gitignore'), 'utf8'), /^alpha\/$/m);

  const descriptor = JSON.parse(readFileSync(join(projectPath, 'ks-context', 'project.json'), 'utf8'));
  assert.equal(descriptor.id, result.project.id);
  assert.equal(descriptor.workspace, 'work');
  assert.deepEqual(descriptor.gitIdentity, {
    name: 'Test Project Owner',
    email: 'test-project-owner@example.com'
  });
  assert.equal(gitOutput(join(projectPath, 'alpha'), ['log', '-1', '--format=%an <%ae>']), 'Test Project Owner <test-project-owner@example.com>');
  assert.equal(gitOutput(projectPath, ['log', '-1', '--format=%an <%ae>']), 'Test Project Owner <test-project-owner@example.com>');
});

test('ks project create permits an empty project Git identity for local-only work', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workRoot = join(home, 'projects', 'work');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workRoot, '--json']).status, 0);

  const created = runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'missing-identity', '--json']);

  assert.equal(created.status, 0, created.stderr);
  const projectPath = join(workRoot, 'missing-identity-proj');
  const descriptor = JSON.parse(readFileSync(join(projectPath, 'ks-context', 'project.json'), 'utf8'));
  assert.equal(descriptor.gitIdentity, null);
  assert.equal(gitOutput(projectPath, ['log', '-1', '--format=%an <%ae>']), 'KaleidoSphere Local <local@kaleidosphere.invalid>');
  assert.equal(gitOutput(join(projectPath, 'missing-identity'), ['log', '-1', '--format=%an <%ae>']), 'KaleidoSphere Local <local@kaleidosphere.invalid>');
});

test('ks project check rejects a worksite whose outer directory does not use the -proj suffix', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workRoot = join(home, 'projects', 'work');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workRoot, '--json']).status, 0);
  const created = JSON.parse(runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'alpha', '--json']).stdout);
  const incorrectPath = join(workRoot, 'alpha');
  require('node:fs').renameSync(created.project.path, incorrectPath);

  const updated = runKs([
    'project', 'update', '--home', home, '--id', created.project.id,
    '--path', incorrectPath, '--layout', 'worksite', '--json'
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const checked = JSON.parse(runKs(['project', 'check', '--home', home, '--id', created.project.id, '--json']).stdout);
  assert.equal(checked.compliant, false);
  assert.equal(checked.checks.find((check) => check.id === 'path.worksite-name').passed, false);
});

test('ks project create rejects a partial project Git identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workRoot = join(home, 'projects', 'work');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workRoot, '--json']).status, 0);

  const created = runKs([
    'project',
    'create',
    '--home',
    home,
    '--workspace',
    'work',
    '--name',
    'partial-identity',
    '--git-name',
    'Only Name',
    '--json'
  ]);

  assert.equal(created.status, 1);
  assert.match(created.stderr, /must be provided together/);
  assert.equal(existsSync(join(workRoot, 'partial-identity-proj')), false);
});
