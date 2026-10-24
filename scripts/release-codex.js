#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(repositoryRoot, 'package.json'));
const RELEASE_SKILLS = [
  'ks',
  'runtime-helper',
  'project-distribution-manager',
  'version-manager',
  'project-rule-manager',
  'execution-coordination'
];

function requiredOption(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a directory path`);
  }
  return path.resolve(value);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildPackage() {
  const outputDir = path.join(repositoryRoot, 'outputs', 'npm');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = run(npm, ['pack', '--json', '--pack-destination', outputDir], { cwd: repositoryRoot });
  const packages = JSON.parse(output);
  if (packages.length !== 1 || !packages[0].filename) {
    throw new Error('npm pack did not return exactly one package');
  }
  return path.join(outputDir, packages[0].filename);
}

function skillUsesKsCli(skillContents) {
  return /(^|[^\w-])ks\s+(?:--version|project|spark|version|coordination|chat-room|doctor|install|uninstall)\b/m.test(skillContents);
}

function assertKsCliRuntimeContract(skillName, skillRoot) {
  const skillPath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`required release skill is missing: ${skillName}`);
  }

  const skillContents = fs.readFileSync(skillPath, 'utf8');
  if (skillName === 'ks') {
    if (!/统一轻量入口/.test(skillContents) || !/Runtime bootstrap 与 KS 自维护/.test(skillContents)) {
      throw new Error('ks release skill must retain its thin-entry routing contract');
    }
    return;
  }
  if (!skillUsesKsCli(skillContents)) {
    return;
  }

  const hasContractHeading = /^##\s+(?:KS CLI Runtime Contract|CLI Runtime Contract|KS CLI 前置条件)\s*$/m.test(skillContents);
  const guideMatch = skillContents.match(/references\/(ks-cli(?:-runtime-contract)?\.md)/);
  const guidePath = guideMatch && path.join(skillRoot, 'references', guideMatch[1]);
  const guideContents = guidePath && fs.existsSync(guidePath)
    ? fs.readFileSync(guidePath, 'utf8')
    : '';
  const contractContents = `${skillContents}\n${guideContents}`;
  const hasVersionCheck = /ks\s+--version\b/.test(contractContents);
  const hasTarballInstall = /npm\s+install\s+--global/.test(contractContents) && /kaleidosphere-<version>\.tgz/.test(contractContents);
  const protectsKsHome = /(?:不得|禁止).*?直接\s*(?:读写|读取|修改).*?(?:\$KS_HOME|~\/\.ks)/s.test(contractContents);

  if (!hasContractHeading || !guidePath || !hasVersionCheck || !hasTarballInstall || !protectsKsHome) {
    throw new Error(
      `skill ${skillName} calls ks CLI but does not satisfy the KS CLI Runtime Contract ` +
      '(heading, a bundled contract guide, ks --version, tarball installation, and no direct ~/.ks access are required)'
    );
  }
}

function validateReleaseSkills() {
  const runtimeScript = path.join(repositoryRoot, 'skills', 'runtime-helper', 'scripts', 'ensure-runtime.js');
  if (!fs.existsSync(runtimeScript)) {
    throw new Error('runtime-helper must include scripts/ensure-runtime.js');
  }
  return RELEASE_SKILLS.map((skillName) => {
    const skillRoot = path.join(repositoryRoot, 'skills', skillName);
    assertKsCliRuntimeContract(skillName, skillRoot);
    return { name: skillName, root: skillRoot };
  });
}

function resolveMarketplaceRepository(marketplacePath) {
  if (fs.existsSync(path.join(marketplacePath, '.git'))) {
    return marketplacePath;
  }
  throw new Error('--marketplace must point to the marketplace Git repository root');
}

function copyDistributionReadmes(destinationRoot) {
  for (const readmeName of ['README.md', 'README_CN.md']) {
    fs.copyFileSync(
      path.join(repositoryRoot, 'docs', 'distribution', readmeName),
      path.join(destinationRoot, readmeName)
    );
  }
}

function copyReleaseSkills(destinationRoot, releaseSkills) {
  for (const skill of releaseSkills) {
    fs.cpSync(skill.root, path.join(destinationRoot, 'skills', skill.name), { recursive: true });
  }
}

function buildKiroPower(marketplaceRoot, releaseSkills, tarball) {
  const powerRoot = marketplaceRoot;
  for (const generatedPath of ['plugin.json', 'README.md', 'README_CN.md', 'skills', 'resources']) {
    fs.rmSync(path.join(powerRoot, generatedPath), { recursive: true, force: true });
  }
  fs.rmSync(path.join(marketplaceRoot, 'powers', 'kaleidosphere'), { recursive: true, force: true });
  fs.mkdirSync(path.join(powerRoot, 'resources'), { recursive: true });
  copyDistributionReadmes(powerRoot);
  copyReleaseSkills(powerRoot, releaseSkills);
  fs.copyFileSync(tarball, path.join(powerRoot, 'resources', path.basename(tarball)));
  writeJson(path.join(powerRoot, 'plugin.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'kaleidosphere',
    version: packageJson.version,
    description: 'A plugin-based AI work resource coordination layer for human-agent collaboration.',
    keywords: [
      'kaleidosphere',
      'ks',
      'project assets',
      'project worksites',
      'sparks',
      'execution coordination',
      'agent collaboration'
    ],
    author: { name: 'cctice' }
  });
  return powerRoot;
}

function release(marketplacePath, { includeKiro = false } = {}) {
  const marketplaceRoot = resolveMarketplaceRepository(marketplacePath);
  if (!fs.existsSync(path.join(marketplaceRoot, '.git'))) {
    throw new Error('--marketplace must point to an initialized Git repository');
  }

  const releaseSkills = validateReleaseSkills();
  const tarball = buildPackage();
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'kaleidosphere');
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'resources'), { recursive: true });
  copyDistributionReadmes(pluginRoot);
  copyReleaseSkills(pluginRoot, releaseSkills);
  fs.copyFileSync(tarball, path.join(pluginRoot, 'resources', path.basename(tarball)));

  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'kaleidosphere',
    version: packageJson.version,
    description: 'A plugin-based AI work resource coordination layer for human-agent collaboration.',
    author: { name: 'cctice' },
    skills: './skills/',
    interface: {
      displayName: 'KaleidoSphere',
      shortDescription: 'A plugin-based AI work resource coordination layer.',
      longDescription: 'KaleidoSphere coordinates projects, worksites, context, capabilities, tools, providers, and explicit complex execution across Agents. This release provides the KS routing entry, runtime repair, local project assets, global spark management, optional version and project-rule management, plus controlled execution coordination and chat-room state for explicitly requested complex work.',
      developerName: 'cctice',
      category: 'Developer Tools',
      capabilities: ['Interactive', 'Write'],
      defaultPrompt: 'Orient me in KaleidoSphere. Explain its goal, state the currently available capabilities, and use them only when relevant.'
    }
  });

  const claudePlugin = {
    name: 'kaleidosphere',
    version: packageJson.version,
    description: 'A plugin-based AI work resource coordination layer for human-agent collaboration.',
    author: { name: 'cctice' }
  };
  writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), claudePlugin);

  const marketplaceManifestPath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const marketplace = fs.existsSync(marketplaceManifestPath)
    ? JSON.parse(fs.readFileSync(marketplaceManifestPath, 'utf8'))
    : { name: 'workflow-party', interface: { displayName: 'Workflow Party' }, plugins: [] };
  marketplace.name = 'workflow-party';
  marketplace.interface = { ...marketplace.interface, displayName: 'Workflow Party' };
  marketplace.plugins = (marketplace.plugins || []).filter((plugin) => plugin.name !== 'kaleidosphere');
  marketplace.plugins.push({
    name: 'kaleidosphere',
    source: { source: 'local', path: './plugins/kaleidosphere' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools'
  });
  writeJson(marketplaceManifestPath, marketplace);

  const claudeMarketplaceManifestPath = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const claudeMarketplace = fs.existsSync(claudeMarketplaceManifestPath)
    ? JSON.parse(fs.readFileSync(claudeMarketplaceManifestPath, 'utf8'))
    : { name: 'workflow-party', plugins: [] };
  claudeMarketplace.name = 'workflow-party';
  claudeMarketplace.owner = { name: 'cctice' };
  claudeMarketplace.metadata = {
    ...claudeMarketplace.metadata,
    description: 'Personal agent workflow marketplace maintained by cctice.',
    version: packageJson.version
  };
  claudeMarketplace.plugins = (claudeMarketplace.plugins || []).filter((plugin) => plugin.name !== 'kaleidosphere');
  claudeMarketplace.plugins.push({
    ...claudePlugin,
    source: './plugins/kaleidosphere',
    category: 'developer-tools'
  });
  writeJson(claudeMarketplaceManifestPath, claudeMarketplace);

  const kiroPowerRoot = includeKiro
    ? buildKiroPower(marketplaceRoot, releaseSkills, tarball)
    : null;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    pluginRoot,
    tarball: path.basename(tarball),
    version: packageJson.version,
    manifests: {
      codexMarketplace: marketplaceManifestPath,
      claudeMarketplace: claudeMarketplaceManifestPath,
      codexPlugin: path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
      claudePlugin: path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      ...(kiroPowerRoot ? { kiroPower: path.join(kiroPowerRoot, 'plugin.json') } : {})
    }
  })}\n`);
}

try {
  const args = process.argv.slice(2);
  release(requiredOption(args, '--marketplace'), { includeKiro: args.includes('--kiro') });
} catch (error) {
  process.stderr.write(`release:codex: ${error.message}\n`);
  process.exitCode = 1;
}
