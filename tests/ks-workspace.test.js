const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
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

test('ks workspace add registers one managed project root and rejects duplicate ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const projectRoot = join(home, 'projects', 'work');

  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);

  const added = runKs([
    'workspace',
    'add',
    '--home',
    home,
    '--id',
    'work',
    '--path',
    projectRoot,
    '--json'
  ]);

  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), {
    ok: true,
    workspace: {
      id: 'work',
      path: projectRoot,
      mode: 'managed'
    }
  });

  const duplicate = runKs([
    'workspace',
    'add',
    '--home',
    home,
    '--id',
    'work',
    '--path',
    join(home, 'another-work-root'),
    '--json'
  ]);

  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /workspace id already exists: work/);
});
