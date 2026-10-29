// tests/ks-market-install.test.js — 市场安装/升级生命周期门（维护包八轮）
//
// 痛点：market list 只读了三轮——发现之后仍要人装。本轮 install/upgrade 补上：
//   ① install：验指纹（清单 integrity ↔ 产物 sha256）→ 解包过 canonical 契约 →
//      落 home/plugins/<name>/（plugin list 立即可见 source=installed）→
//      state/installed.json 记档（版本/来源/指纹/时刻）；
//   ② 完整性红线：产物被换/指纹不符拒绝安装（wfp provenance 链的消费侧闭合）；
//   ③ 幂等诚实：同版重装拒绝（--force 重装）、未装先 upgrade 拒绝、
//      市场版本低于已装拒绝降级；
//   ④ upgrade：新版走同一验证链替换 + from/to 记档；同版 upToDate；
//   ⑤ 诚实边界：https 市场不装半截；产物非插件形态（缺 plugin.json）拒绝；
//   ⑥ list 联动：installed 标记（current/stale）。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

const runJson = (args) => JSON.parse(runKs(args).stdout);

/** 造一个本地市场：某插件某版本的插件形态 tgz 产物 + marketplace.json */
function fixtureMarket() {
  const market = mkdtempSync(join(tmpdir(), 'ks-mkt-'));
  buildPluginArtifact(market, 'demo-engine', '1.0.0');
  writeMarketManifest(market, [
    { name: 'demo-engine', version: '1.0.0', source: './plugins/demo-engine', category: 'developer-tools', integrity: shaOf(artifactPath(market, 'demo-engine', '1.0.0')) },
  ]);
  return market;
}

function artifactPath(market, name, version) {
  return join(market, 'plugins', name, 'resources', `${name}-${version}.tgz`);
}

function shaOf(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

/** 按 wfp 插件形态打包：package/plugin.json + skills（tar 真打包，非手拼） */
function buildPluginArtifact(market, name, version, { skillsForm = './skills/' } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'ks-pkg-'));
  const pkg = join(stage, 'package');
  mkdirSync(join(pkg, 'skills', `${name}-flow`), { recursive: true });
  writeFileSync(join(pkg, 'skills', `${name}-flow`, 'SKILL.md'), `# ${name} flow\n`);
  writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ name, version, skills: skillsForm }));
  mkdirSync(join(market, 'plugins', name, 'resources'), { recursive: true });
  const out = artifactPath(market, name, version);
  const tar = spawnSync('tar', ['-czf', out, 'package'], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(tar.status, 0, `fixture tar 失败: ${tar.stderr}`);
  return out;
}

function writeMarketManifest(market, plugins) {
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'fixture-market',
    owner: { name: 'cctice' },
    plugins,
  }));
}

test('install：指纹验证+契约过门+落位 plugin list 可见+installed.json 记档', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const result = runJson(['market', 'install', 'demo-engine', '--home', home, '--source', market]);

  assert.equal(result.name, 'demo-engine');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.integrityVerified, true, '清单带 integrity 必须验过');
  assert.ok(existsSync(join(home, 'plugins', 'demo-engine', 'plugin.json')), '落位 home/plugins');
  assert.ok(existsSync(join(home, 'plugins', 'demo-engine', 'skills', 'demo-engine-flow', 'SKILL.md')));

  const state = JSON.parse(readFileSync(join(home, 'state', 'installed.json'), 'utf8'));
  assert.equal(state['demo-engine'].version, '1.0.0');
  assert.equal(state['demo-engine'].integrityVerified, true);
  assert.match(state['demo-engine'].installedAt, /^\d{4}-\d{2}-\d{2}T/);

  const listed = runJson(['plugin', 'list', '--home', home]);
  const installed = listed.plugins.find((plugin) => plugin.name === 'demo-engine');
  assert.equal(installed.source, 'installed', 'plugin list 立即可见');
  assert.equal(installed.passed, true, '装进来的就是契约干净的');
});

test('完整性红线：产物被换（指纹不符）拒绝安装，分毫不动 home', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const artifact = artifactPath(market, 'demo-engine', '1.0.0');
  writeFileSync(artifact, readFileSync(artifact).length ? Buffer.concat([readFileSync(artifact), Buffer.from('tampered')]) : Buffer.alloc(0));
  const run = runKs(['market', 'install', 'demo-engine', '--home', home, '--source', market]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /integrity mismatch/);
  assert.ok(!existsSync(join(home, 'plugins', 'demo-engine')), '被拒安装不留半截');
});

test('幂等诚实：同版重装拒绝+--force 重装；未装 upgrade 拒绝', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  runJson(['market', 'install', 'demo-engine', '--home', home, '--source', market]);

  const again = runKs(['market', 'install', 'demo-engine', '--home', home, '--source', market]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already installed/);
  const forced = runJson(['market', 'install', 'demo-engine', '--home', home, '--source', market, '--force']);
  assert.equal(forced.version, '1.0.0');

  const notInstalled = runKs(['market', 'upgrade', 'demo-engine', '--home', mkdtempSync(join(tmpdir(), 'ks-home-')), '--source', market]);
  assert.equal(notInstalled.status, 1);
  assert.match(notInstalled.stderr, /not installed/);
});

test('upgrade：新版同链验证替换+from/to 记档；同版 upToDate；市场更旧拒绝降级', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  runJson(['market', 'install', 'demo-engine', '--home', home, '--source', market]);

  // 市场发新版 1.1.0
  buildPluginArtifact(market, 'demo-engine', '1.1.0');
  writeMarketManifest(market, [
    { name: 'demo-engine', version: '1.1.0', source: './plugins/demo-engine', category: 'developer-tools', integrity: shaOf(artifactPath(market, 'demo-engine', '1.1.0')) },
  ]);
  const up = runJson(['market', 'upgrade', 'demo-engine', '--home', home, '--source', market, '--refresh']);
  assert.equal(up.upgraded, true);
  assert.equal(up.from, '1.0.0');
  assert.equal(up.to, '1.1.0');
  const state = JSON.parse(readFileSync(join(home, 'state', 'installed.json'), 'utf8'));
  assert.equal(state['demo-engine'].version, '1.1.0');
  const listed = runJson(['plugin', 'list', '--home', home]);
  assert.equal(listed.plugins.find((plugin) => plugin.name === 'demo-engine').version, '1.1.0');

  const same = runJson(['market', 'upgrade', 'demo-engine', '--home', home, '--source', market]);
  assert.equal(same.upToDate, true);

  // 市场回退到旧版（指向旧市场源）：拒绝降级
  writeMarketManifest(market, [
    { name: 'demo-engine', version: '1.0.0', source: './plugins/demo-engine', category: 'developer-tools', integrity: shaOf(artifactPath(market, 'demo-engine', '1.0.0')) },
  ]);
  const downgrade = runKs(['market', 'upgrade', 'demo-engine', '--home', home, '--source', market, '--refresh']);
  assert.equal(downgrade.status, 1);
  assert.match(downgrade.stderr, /older than installed/);
});

test('诚实边界：https 市场不装半截；非插件形态产物拒绝；无名条目点名', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  // 条目级远端 source：本地市场里的 https 条目同样不装半截
  buildPluginArtifact(market, 'remote-engine', '0.9.0');
  writeMarketManifest(market, [
    { name: 'remote-engine', version: '0.9.0', source: 'https://example.com/x/tree/main/plugins/remote-engine', category: 'developer-tools' },
  ]);
  const httpsRun = runKs(['market', 'install', 'remote-engine', '--home', home, '--source', market, '--refresh']);
  assert.equal(httpsRun.status, 1);
  assert.match(httpsRun.stderr, /local marketplace/);

  const missing = runKs(['market', 'install', 'no-such-plugin', '--home', home, '--source', market]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /has no plugin 'no-such-plugin'/);

  // 产物在但清单没登记 integrity（bundled 形态）：装但如实记 integrityVerified=false
  buildPluginArtifact(market, 'no-integrity-engine', '0.5.0');
  writeMarketManifest(market, [
    { name: 'no-integrity-engine', version: '0.5.0', source: './plugins/no-integrity-engine', category: 'developer-tools' },
  ]);
  const noIntegrity = runJson(['market', 'install', 'no-integrity-engine', '--home', home, '--source', market, '--refresh']);
  assert.equal(noIntegrity.integrityVerified, false, '无 integrity 如实不宣称验过');
  assert.ok(noIntegrity.contentSha256.startsWith('sha256:'), '实指纹照记，装后可复核');
});

test('list 联动：installed 标记 current/stale 与 install 状态同源', () => {
  const market = fixtureMarket();
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const before = runJson(['market', 'list', '--home', home, '--source', market]);
  assert.equal(before.plugins.find((plugin) => plugin.name === 'demo-engine').installed, false);

  runJson(['market', 'install', 'demo-engine', '--home', home, '--source', market]);
  const current = runJson(['market', 'list', '--home', home, '--source', market, '--refresh']);
  assert.equal(current.plugins.find((plugin) => plugin.name === 'demo-engine').installed, 'current');

  buildPluginArtifact(market, 'demo-engine', '2.0.0');
  writeMarketManifest(market, [
    { name: 'demo-engine', version: '2.0.0', source: './plugins/demo-engine', category: 'developer-tools', integrity: shaOf(artifactPath(market, 'demo-engine', '2.0.0')) },
  ]);
  const stale = runJson(['market', 'list', '--home', home, '--source', market, '--refresh']);
  assert.equal(stale.plugins.find((plugin) => plugin.name === 'demo-engine').installed, 'stale(1.0.0)');
});

test('真实 wfp 市场端到端：kaleidosphere 产物可装可用（同机在位时）', { skip: !existsSync('/Users/cy/projects-ks/playground/wfp-fork-proj/workflow-party/.claude-plugin/marketplace.json') && 'wfp 仓不在本机' }, () => {
  const wfp = '/Users/cy/projects-ks/playground/wfp-fork-proj/workflow-party';
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const result = runJson(['market', 'install', 'kfc-plugin', '--home', home, '--source', wfp]);
  assert.equal(result.integrityVerified, true, 'wfp 真清单真指纹全链验证');
  const listed = runJson(['plugin', 'list', '--home', home]);
  const installed = listed.plugins.find((plugin) => plugin.name === 'kfc-plugin');
  assert.equal(installed.source, 'installed');
  assert.equal(installed.passed, true);
});
