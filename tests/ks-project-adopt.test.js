const assert = require('node:assert/strict');
const { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('ks project adopt plans then moves an external Git repository into a registered worksite', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const personal = join(home, 'projects', 'personal');
  const source = join(home, 'outside', 'creative-system');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'README.md'), '# Creative system\n');
  git(source, ['init']);
  git(source, ['config', 'user.name', 'Test User']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['remote', 'add', 'origin', 'git@example.com:cctice/creative-system.git']);
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-m', 'initial']);
  const head = git(source, ['rev-parse', 'HEAD']);

  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'personal', '--path', personal, '--json']).status, 0);
  const planned = runKs([
    'project', 'adopt', '--home', home, '--source', source, '--workspace', 'personal', '--name', 'creative-system',
    '--tag', 'efficiency', '--alias', '创意生产系统', '--summary', '个人提效项目', '--json'
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).plan;
  assert.equal(plan.type, 'project-adopt');
  assert.equal(plan.source.path, source);
  assert.equal(plan.target.worksite, join(personal, 'creative-system-proj'));
  assert.equal(plan.repository.head, head);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(plan.target.worksite), false);

  const applied = runKs(['project', 'adopt', '--home', home, '--apply', '--plan', plan.id, '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  const worksite = join(personal, 'creative-system-proj');
  const repo = join(worksite, 'creative-system');
  assert.equal(result.applied, true);
  assert.equal(result.project.layout, 'worksite');
  assert.deepEqual(result.project.tags, ['efficiency']);
  assert.deepEqual(result.project.aliases, ['创意生产系统']);
  assert.equal(result.project.summary, '个人提效项目');
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(join(worksite, '.git')), true);
  assert.equal(existsSync(join(repo, '.git')), true);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(git(repo, ['remote', 'get-url', 'origin']), 'git@example.com:cctice/creative-system.git');
  assert.match(require('node:fs').readFileSync(join(worksite, '.gitignore'), 'utf8'), /^creative-system\/$/m);
  const checked = runKs(['project', 'check', '--home', home, '--id', result.project.id, '--json']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).compliant, true);
});

test('ks project adopt refuses a dirty source until preserve-worktree is explicitly requested', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const personal = join(home, 'projects', 'personal');
  const source = join(home, 'outside', 'dirty-system');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'README.md'), '# Dirty\n');
  git(source, ['init']);
  git(source, ['config', 'user.name', 'Test User']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-m', 'initial']);
  writeFileSync(join(source, 'README.md'), '# Dirty changed\n');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'personal', '--path', personal, '--json']).status, 0);

  const rejected = runKs(['project', 'adopt', '--home', home, '--source', source, '--workspace', 'personal', '--name', 'dirty-system', '--json']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--preserve-worktree/);
  assert.equal(existsSync(source), true);
});

test('ks project adopt rolls the repository back to its source path when worksite initialization fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const personal = join(home, 'projects', 'personal');
  const source = join(home, 'outside', 'rollback-system');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'README.md'), '# Rollback\n');
  git(source, ['init']);
  git(source, ['config', 'user.name', 'Test User']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-m', 'initial']);
  const head = git(source, ['rev-parse', 'HEAD']);
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'personal', '--path', personal, '--json']).status, 0);
  const planned = JSON.parse(runKs([
    'project', 'adopt', '--home', home, '--source', source, '--workspace', 'personal', '--name', 'rollback-system', '--json'
  ]).stdout).plan;

  const shimDirectory = join(home, 'git-shim');
  mkdirSync(shimDirectory);
  const shim = join(shimDirectory, 'git');
  writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "init" ] && echo "$PWD" | grep -q "rollback-system-proj$"; then exit 97; fi\nexec "$KS_REAL_GIT" "$@"\n');
  chmodSync(shim, 0o755);
  const applied = runKs([
    'project', 'adopt', '--home', home, '--apply', '--plan', planned.id, '--json'
  ], {
    PATH: `${shimDirectory}:${process.env.PATH}`,
    KS_REAL_GIT: spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
  });

  assert.equal(applied.status, 1);
  assert.equal(existsSync(source), true);
  assert.equal(git(source, ['rev-parse', 'HEAD']), head);
  assert.equal(existsSync(planned.target.worksite), false);
});
