const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const packageVersion = require('../package.json').version;

test('ks --version reports the installed package version', () => {
  const result = spawnSync(process.execPath, ['cli/ks.js', '--version'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
});
