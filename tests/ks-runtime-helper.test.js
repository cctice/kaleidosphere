const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const runtimeHelper = path.join(__dirname, '..', 'skills', 'runtime-helper', 'scripts', 'ensure-runtime.js');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function createFixture(initialVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-runtime-helper-'));
  const pluginRoot = path.join(root, 'plugin');
  const resourcesRoot = path.join(pluginRoot, 'resources');
  const binRoot = path.join(root, 'bin');
  const versionFile = path.join(root, 'version');
  const npmLog = path.join(root, 'npm-log');
  fs.mkdirSync(resourcesRoot, { recursive: true });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(resourcesRoot, 'kaleidosphere-0.4.1.tgz'), 'fixture');
  fs.writeFileSync(versionFile, `${initialVersion}\n`);
  writeExecutable(path.join(binRoot, 'ks'), `#!/bin/sh\ncat "${versionFile}"\n`);
  writeExecutable(path.join(binRoot, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\nprintf '0.4.1\\n' > "${versionFile}"\n`);
  return { root, pluginRoot, binRoot, versionFile, npmLog };
}

function runFixture(fixture, args = ['--plugin-root', fixture.pluginRoot, '--json']) {
  return spawnSync(process.execPath, [runtimeHelper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixture.binRoot}:${process.env.PATH}` }
  });
}

test('runtime helper upgrades a mismatched ks runtime from the active plugin tarball', () => {
  const fixture = createFixture('0.4.0');
  const result = runFixture(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    updated: true,
    expectedVersion: '0.4.1',
    beforeVersion: '0.4.0',
    afterVersion: '0.4.1',
    tarball: path.join(fixture.pluginRoot, 'resources', 'kaleidosphere-0.4.1.tgz')
  });
  assert.match(fs.readFileSync(fixture.npmLog, 'utf8'), /install --global .*kaleidosphere-0\.4\.1\.tgz/);
});

test('runtime helper does not install when the global ks runtime already matches', () => {
  const fixture = createFixture('0.4.1');
  const result = runFixture(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, false);
  assert.equal(fs.existsSync(fixture.npmLog), false);
});

test('runtime helper resolves the plugin root from its bundled location by default', () => {
  const fixture = createFixture('0.4.1');
  const bundledScript = path.join(fixture.pluginRoot, 'skills', 'runtime-helper', 'scripts', 'ensure-runtime.js');
  fs.mkdirSync(path.dirname(bundledScript), { recursive: true });
  fs.copyFileSync(runtimeHelper, bundledScript);
  const result = spawnSync(process.execPath, [bundledScript, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixture.binRoot}:${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.realpathSync(JSON.parse(result.stdout).tarball),
    fs.realpathSync(path.join(fixture.pluginRoot, 'resources', 'kaleidosphere-0.4.1.tgz'))
  );
});
