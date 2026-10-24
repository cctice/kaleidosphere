const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('release:marketplace builds Codex and Claude marketplace outputs with the runtime-only ks package', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-release-'));
  const marketplaceRoot = path.join(temporaryRoot, 'workflow-party');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: marketplaceRoot });

  const result = spawnSync(
    process.execPath,
    ['scripts/release-codex.js', '--marketplace', marketplaceRoot],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);

  const marketplace = JSON.parse(
    fs.readFileSync(path.join(marketplaceRoot, '.agents/plugins/marketplace.json'), 'utf8')
  );
  assert.deepEqual(marketplace.plugins, [{
    name: 'kaleidosphere',
    source: { source: 'local', path: './plugins/kaleidosphere' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools'
  }]);

  const pluginRoot = path.join(marketplaceRoot, 'plugins/kaleidosphere');
  assert.ok(fs.existsSync(path.join(pluginRoot, 'skills/runtime-helper/scripts/ensure-runtime.js')));
  for (const readmeName of ['README.md', 'README_CN.md']) {
    assert.equal(
      fs.readFileSync(path.join(pluginRoot, readmeName), 'utf8'),
      fs.readFileSync(path.join(repositoryRoot, 'docs/distribution', readmeName), 'utf8'),
      `${readmeName} is bundled from the distribution template`
    );
  }
  assert.equal(fs.existsSync(path.join(pluginRoot, 'docs')), false);
  const pluginManifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8')
  );
  assert.equal(fs.existsSync(path.join(marketplaceRoot, 'plugin.json')), false);
  assert.match(pluginManifest.interface.defaultPrompt, /goal/i);
  assert.match(pluginManifest.interface.defaultPrompt, /currently available/i);
  const packageFiles = fs.readdirSync(path.join(pluginRoot, 'resources'));
  assert.equal(packageFiles.length, 1);
  assert.match(packageFiles[0], /^kaleidosphere-\d+\.\d+\.\d+\.tgz$/);
  for (const skillName of ['ks', 'runtime-helper', 'project-distribution-manager', 'version-manager', 'project-rule-manager', 'execution-coordination']) {
    const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), `${skillName} is bundled`);
    const skill = fs.readFileSync(skillPath, 'utf8');
    if (skillName === 'ks') {
      assert.match(skill, /统一轻量入口/);
      assert.match(skill, /Runtime bootstrap 与 KS 自维护/);
      continue;
    }
    assert.match(skill, /(?:KS )?CLI (?:Runtime Contract|前置条件)/);
    const referencesRoot = path.join(pluginRoot, 'skills', skillName, 'references');
    const contractGuide = ['ks-cli.md', 'ks-cli-runtime-contract.md']
      .map((fileName) => path.join(referencesRoot, fileName))
      .find(fs.existsSync);
    assert.ok(contractGuide, `${skillName} includes its CLI runtime contract guide`);
    assert.match(fs.readFileSync(contractGuide, 'utf8'), /ks\s+--version/);
    if (skillName === 'execution-coordination') {
      assert.match(skill, /ks coordination/);
      assert.match(skill, /ks chat-room/);
    }
  }

  const projectDistributionManager = fs.readFileSync(
    path.join(pluginRoot, 'skills/project-distribution-manager/SKILL.md'),
    'utf8'
  );
  assert.match(projectDistributionManager, /当前第一项已实现能力/);

  const ksEntry = fs.readFileSync(path.join(pluginRoot, 'skills/ks/SKILL.md'), 'utf8');
  assert.match(ksEntry, /统一轻量入口/);
  assert.match(ksEntry, /runtime-helper/);
  assert.match(ksEntry, /project-distribution-manager/);
  assert.match(ksEntry, /version-manager/);
  assert.match(ksEntry, /project-rule-manager/);
  assert.match(ksEntry, /execution-coordination/);
  assert.doesNotMatch(ksEntry, /ks --version/);
  assert.doesNotMatch(ksEntry, /ks project check/);

  assert.match(pluginManifest.interface.longDescription, /routing entry/i);
  assert.match(pluginManifest.interface.longDescription, /project asset/i);
  assert.match(pluginManifest.interface.longDescription, /execution coordination/i);

  const claudeMarketplace = JSON.parse(
    fs.readFileSync(path.join(marketplaceRoot, '.claude-plugin/marketplace.json'), 'utf8')
  );
  assert.equal(claudeMarketplace.name, 'workflow-party');
  assert.deepEqual(claudeMarketplace.plugins, [{
    name: 'kaleidosphere',
    version: require(path.join(repositoryRoot, 'package.json')).version,
    description: 'A plugin-based AI work resource coordination layer for human-agent collaboration.',
    author: { name: 'cctice' },
    source: './plugins/kaleidosphere',
    category: 'developer-tools'
  }]);
  const claudePluginManifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')
  );
  assert.equal(claudePluginManifest.name, 'kaleidosphere');
  assert.equal(claudePluginManifest.version, require(path.join(repositoryRoot, 'package.json')).version);

  const archive = execFileSync('tar', ['-tzf', path.join(pluginRoot, 'resources', packageFiles[0])], { encoding: 'utf8' });
  assert.match(archive, /package\/cli\/ks\.js/);
  assert.doesNotMatch(archive, /package\/tests\//);
  assert.doesNotMatch(archive, /package\/outputs\//);
});

test('release:marketplace requires the explicit marketplace repository root', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-release-not-repository-'));
  fs.mkdirSync(temporaryRoot, { recursive: true });

  const result = spawnSync(
    process.execPath,
    ['scripts/release-codex.js', '--marketplace', temporaryRoot],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /marketplace Git repository root/);
});

test('release:marketplace creates the Kiro Power only with explicit opt-in', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-release-kiro-'));
  const marketplaceRoot = path.join(temporaryRoot, 'workflow-party');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: marketplaceRoot });

  const result = spawnSync(
    process.execPath,
    ['scripts/release-codex.js', '--marketplace', marketplaceRoot, '--kiro'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const powerRoot = marketplaceRoot;
  const powerManifest = JSON.parse(fs.readFileSync(path.join(powerRoot, 'plugin.json'), 'utf8'));
  assert.equal(powerManifest.name, 'kaleidosphere');
  assert.equal(powerManifest.version, require(path.join(repositoryRoot, 'package.json')).version);
  assert.ok(powerManifest.keywords.includes('ks'));
  assert.ok(fs.existsSync(path.join(powerRoot, 'skills/ks/SKILL.md')));
  assert.ok(fs.existsSync(path.join(powerRoot, 'resources', `kaleidosphere-${powerManifest.version}.tgz`)));
});
