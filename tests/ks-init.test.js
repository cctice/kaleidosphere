const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, readFileSync } = require('node:fs');
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

test('ks init creates an idempotent user-level registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));

  const firstRun = runKs(['init', '--home', home, '--json']);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.deepEqual(JSON.parse(firstRun.stdout), {
    ok: true,
    initialized: true,
    home
  });

  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.equal(existsSync(join(home, 'registry', 'workspaces.json')), true);
  assert.equal(existsSync(join(home, 'registry', 'projects.json')), true);
  assert.equal(existsSync(join(home, 'registry', 'sparks.json')), true);
  assert.equal(JSON.parse(readFileSync(join(home, 'registry', 'projects.json'), 'utf8')).projects.length, 0);

  const secondRun = runKs(['init', '--home', home, '--json']);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.deepEqual(JSON.parse(secondRun.stdout), {
    ok: true,
    initialized: false,
    home
  });
});
