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

test('ks spark discovers the global sparks directory and appends an explicit section through the CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const projectRoot = join(home, 'projects');
  const workspace = join(projectRoot, 'work');
  const sparks = join(projectRoot, 'sparks');
  const existing = join(sparks, 'existing-spark.md');
  const contentFile = join(home, 'section.md');
  mkdirSync(sparks, { recursive: true });
  writeFileSync(existing, '---\ntitle: Existing Spark\ndate: 2026-08-01\nscope: global\n---\n\n# Existing Spark\n');
  writeFileSync(contentFile, 'This was appended by the controlled CLI.\n');

  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);

  const listed = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(listed.directory, sparks);
  assert.equal(listed.sparks.length, 1);
  assert.equal(listed.sparks[0].title, 'Existing Spark');

  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'existing', '--json']).stdout);
  assert.equal(found.sparks.length, 1);
  const id = found.sparks[0].id;

  const appended = JSON.parse(runKs([
    'spark', 'append-section', '--home', home, '--id', id,
    '--heading', 'Investigation Notes', '--content-file', contentFile, '--json'
  ]).stdout);
  assert.equal(appended.insertedHeading, '## Investigation Notes');
  assert.match(readFileSync(existing, 'utf8'), /## Investigation Notes\n\nThis was appended by the controlled CLI\./);

  const checked = JSON.parse(runKs(['spark', 'check', '--home', home, '--id', id, '--json']).stdout);
  assert.equal(checked.compliant, true);
});

test('ks spark append-section rejects a duplicate section heading in the content file', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const projectRoot = join(home, 'projects');
  const workspace = join(projectRoot, 'work');
  const sparks = join(projectRoot, 'sparks');
  const existing = join(sparks, 'existing-spark.md');
  const contentFile = join(home, 'duplicate-heading.md');
  mkdirSync(sparks, { recursive: true });
  writeFileSync(existing, '---\ntitle: Existing Spark\ndate: 2026-08-01\nscope: global\n---\n\n# Existing Spark\n');
  writeFileSync(contentFile, '## Investigation Notes\n\nThis must not be appended.\n');

  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const id = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout).sparks[0].id;

  const result = runKs([
    'spark', 'append-section', '--home', home, '--id', id,
    '--heading', 'Investigation Notes', '--content-file', contentFile, '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /content-file already starts with the same Markdown heading/);
  assert.doesNotMatch(readFileSync(existing, 'utf8'), /Investigation Notes/);
});

test('ks spark create supports non-ASCII titles without direct spark file writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const projectRoot = join(home, 'projects');
  const sparks = join(home, 'managed-sparks');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', join(projectRoot, 'work'), '--json']).status, 0);
  const configured = JSON.parse(runKs(['spark', 'configure', '--home', home, '--path', sparks, '--json']).stdout);
  assert.equal(configured.directory, sparks);

  const created = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', '多 Agent 协作想法', '--json']).stdout);
  assert.equal(created.spark.title, '多 Agent 协作想法');
  assert.equal(existsSync(created.spark.path), true);
  assert.match(readFileSync(created.spark.path, 'utf8'), /^title: 多 Agent 协作想法$/m);

  const inspected = JSON.parse(runKs(['spark', 'inspect', '--home', home, '--id', created.spark.id, '--json']).stdout);
  assert.equal(inspected.directory, sparks);
  assert.match(inspected.content, /^# 多 Agent 协作想法$/m);
});
