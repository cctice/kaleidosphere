const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('ks project migrate converts an explicitly registered direct repository into a development worksite', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'tooling');
  const sourcePath = join(workspace, 'existing-project');
  const projectPath = join(workspace, 'existing-project-proj');
  mkdirSync(join(sourcePath, 'ks-context'), { recursive: true });
  writeFileSync(join(sourcePath, 'README.md'), '# Existing\n');
  writeFileSync(join(sourcePath, 'ks-context', 'notes.md'), 'local context\n');
  git(sourcePath, ['init']);
  git(sourcePath, ['config', 'user.name', 'Test User']);
  git(sourcePath, ['config', 'user.email', 'test@example.com']);
  git(sourcePath, ['remote', 'add', 'origin', 'git@example.com:team/existing-project.git']);
  git(sourcePath, ['add', '.']);
  git(sourcePath, ['commit', '-m', 'initial']);
  const headBefore = git(sourcePath, ['rev-parse', 'HEAD']);

  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'tooling', '--path', workspace, '--json']).status, 0);
  const registered = JSON.parse(runKs([
    'project', 'register', '--home', home, '--workspace', 'tooling', '--name', 'existing-project', '--path', sourcePath, '--layout', 'direct', '--json'
  ]).stdout);

  const missingExtraction = runKs([
    'project', 'migrate', '--home', home, '--id', registered.project.id, '--to-layout', 'worksite', '--json'
  ]);
  assert.equal(missingExtraction.status, 1);
  assert.match(missingExtraction.stderr, /--extract-context/);

  const planned = JSON.parse(runKs([
    'project', 'migrate', '--home', home, '--id', registered.project.id, '--to-layout', 'worksite', '--extract-context', '--json'
  ]).stdout);
  assert.equal(planned.applied, false);
  assert.equal(planned.plan.repository.head, headBefore);
  assert.equal(planned.plan.target.worksite, projectPath);
  assert.equal(planned.plan.target.repository, join(projectPath, 'existing-project'));
  assert.deepEqual(planned.plan.extraction.trackedFiles, ['ks-context/notes.md']);

  const migrated = runKs([
    'project', 'migrate', '--home', home, '--id', registered.project.id, '--to-layout', 'worksite', '--extract-context', '--apply', '--plan', planned.plan.planId, '--json'
  ]);
  assert.equal(migrated.status, 0, migrated.stderr);
  const result = JSON.parse(migrated.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.project.layout, 'worksite');

  const repoPath = join(projectPath, 'existing-project');
  assert.equal(existsSync(join(repoPath, '.git')), true);
  assert.equal(existsSync(join(projectPath, '.git')), true);
  assert.equal(git(repoPath, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repoPath, ['remote', 'get-url', 'origin']), 'git@example.com:team/existing-project.git');
  assert.equal(readFileSync(join(projectPath, 'ks-context', 'notes.md'), 'utf8'), 'local context\n');
  assert.match(readFileSync(join(projectPath, '.gitignore'), 'utf8'), /^existing-project\/$/m);
  assert.equal(git(projectPath, ['ls-files']).includes('existing-project/README.md'), false);
  assert.match(git(repoPath, ['status', '--short']), /^D ks-context\/notes\.md$/m);

  const resolved = JSON.parse(runKs(['project', 'resolve', '--home', home, '--path', repoPath, '--json']).stdout);
  assert.equal(resolved.project.id, registered.project.id);
  assert.equal(resolved.project.layout, 'worksite');
  const checked = JSON.parse(runKs(['project', 'check', '--home', home, '--id', registered.project.id, '--json']).stdout);
  assert.equal(checked.compliant, true);
  assert.equal(checked.checks.every((check) => check.passed), true);
});

test('ks project migrate requires explicit preserve-worktree for source changes outside ks-context', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const workspace = join(home, 'work');
  const projectPath = join(workspace, 'dirty-project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'README.md'), '# Dirty\n');
  git(projectPath, ['init']);
  git(projectPath, ['config', 'user.name', 'Test User']);
  git(projectPath, ['config', 'user.email', 'test@example.com']);
  git(projectPath, ['add', 'README.md']);
  git(projectPath, ['commit', '-m', 'initial']);
  writeFileSync(join(projectPath, 'README.md'), '# Dirty changed\n');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const registered = JSON.parse(runKs([
    'project', 'register', '--home', home, '--workspace', 'work', '--name', 'dirty-project', '--path', projectPath, '--layout', 'direct', '--json'
  ]).stdout);

  const rejected = runKs(['project', 'migrate', '--home', home, '--id', registered.project.id, '--to-layout', 'worksite', '--json']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--preserve-worktree/);

  const planned = JSON.parse(runKs([
    'project', 'migrate', '--home', home, '--id', registered.project.id, '--to-layout', 'worksite', '--preserve-worktree', '--json'
  ]).stdout);
  assert.equal(planned.plan.preserveWorktree, true);
});
