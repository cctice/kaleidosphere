// tests/ks-market.test.js — 插件市场接线门（维护包四轮：P4 支柱对接 workflow-party）
//
// 痛点：P4 插件市场（workflow-party）仅规划未接线。本轮 ks market list 直读
// workflow-party 形态的 marketplace.json（目录或文件路径），逐条校验条目契约，
// 本地 source 的插件顺带过 canonical 插件契约检查——市场条目与装载契约同门。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function fixtureMarket() {
  const market = mkdtempSync(join(tmpdir(), 'ks-market-'));
  const pluginDir = join(market, 'plugins', 'sample-engine');
  mkdirSync(join(pluginDir, 'skills', 'sample-flow'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', 'sample-flow', 'SKILL.md'), '# sample\n');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'sample-engine', version: '1.2.3', skills: './skills/' }));
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'fixture-market',
    owner: { name: 'cctice' },
    plugins: [
      { name: 'sample-engine', version: '1.2.3', source: './plugins/sample-engine', category: 'developer-tools', integrity: 'sha256:abcd' },
      { name: 'remote-engine', version: '0.9.0', source: 'https://example.com/x/tree/main/plugins/remote/', category: 'developer-tools' },
      { name: 'broken-entry', source: './plugins/nope' }
    ]
  }));
  return market;
}

test('ks market list 读 workflow-party 形态清单：目录自动发现 .claude-plugin/marketplace.json', async () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const run = await new Promise((resolve) => {
    const child = spawnSync(process.execPath, [cliPath, 'market', 'list', '--home', home, '--source', market], { encoding: 'utf8' });
    resolve(JSON.parse(child.stdout));
  });

  assert.equal(run.market, 'fixture-market');
  assert.equal(run.owner, 'cctice');
  assert.equal(run.count, 3);
  assert.equal(run.allValid, false, '坏条目必须拉红，不许静默');

  const sample = run.plugins.find((plugin) => plugin.name === 'sample-engine');
  assert.equal(sample.version, '1.2.3');
  assert.ok(sample.local, '本地 source 必须过插件契约检查');
  assert.equal(sample.local.name, 'sample-engine');
  assert.equal(sample.local.passed, true, 'canonical 本地插件应过契约检查');
  assert.ok(!sample.issues.length, `sample-engine 不应有条目问题: ${JSON.stringify(sample.issues)}`);

  const remote = run.plugins.find((plugin) => plugin.name === 'remote-engine');
  assert.equal(remote.local, null, '远端 source 不做本地检查');
  assert.ok(!remote.issues.length);

  const broken = run.plugins.find((plugin) => plugin.name === 'broken-entry');
  assert.ok(broken.issues.some((issue) => issue.includes('missing version')), '缺 version 未点名');
  assert.ok(broken.issues.some((issue) => issue.includes('no plugin.json')), '本地 source 缺 plugin.json 未点名');
});

test('ks market list 负例：清单不存在 / 缺 plugins 数组', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));

  const missing = runKs(['market', 'list', '--home', home, '--source', join(market, 'nowhere')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /marketplace manifest does not exist/);

  const empty = mkdtempSync(join(tmpdir(), 'ks-market-empty-'));
  writeFileSync(join(empty, 'marketplace.json'), JSON.stringify({ name: 'empty' }));
  const bad = runKs(['market', 'list', '--home', home, '--source', join(empty, 'marketplace.json')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing plugins array/);
});

test('真实 wfp 仓清单（同机在位时）接线可读：远端/本地条目全解析', { skip: !require('node:fs').existsSync('/Users/cy/projects-ks/playground/wfp-fork-proj/workflow-party/.claude-plugin/marketplace.json') && 'wfp 仓不在本机' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const run = await new Promise((resolve) => {
    const child = spawnSync(process.execPath, [cliPath, 'market', 'list', '--home', home, '--source', '/Users/cy/projects-ks/playground/wfp-fork-proj/workflow-party'], { encoding: 'utf8' });
    resolve(JSON.parse(child.stdout));
  });
  assert.equal(run.market, 'workflow-party');
  assert.ok(run.count >= 2, 'wfp 清单至少 kaleidosphere+kfc 两条');
  assert.equal(run.allValid, true, `真实清单不应有条目违约: ${JSON.stringify(run.plugins.map((p) => p.issues))}`);
});
