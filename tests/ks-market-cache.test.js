// tests/ks-market-cache.test.js — 插件发现缓存门（维护包六轮：TTL+mtime 双失效）
//
// 痛点：market list 每次全量重读/重拉清单，而"加缓存"最大的坑是失效面——
// 本地清单文件一变必须立即重读（mtimeNs+size 指纹），远端清单 TTL 内复用、
// 到期或 --refresh 穿透。发布新版插件不许等 TTL 自然过期。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  const child = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function fixtureMarket(version = '1.2.3') {
  const market = mkdtempSync(join(tmpdir(), 'ks-mkt-cache-'));
  const pluginDir = join(market, 'plugins', 'sample-engine');
  mkdirSync(join(pluginDir, 'skills', 'sample-flow'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', 'sample-flow', 'SKILL.md'), '# sample\n');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'sample-engine', version, skills: './skills/' }));
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'cache-market',
    owner: { name: 'cctice' },
    plugins: [{ name: 'sample-engine', version, source: './plugins/sample-engine', category: 'developer-tools' }]
  }));
  return market;
}

function cacheFileFor(home, source) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 24);
  return join(home, 'state', 'market-cache', `${digest}.json`);
}

test('本地清单：首跑 miss 落缓存，指纹未变二跑命中，文件一变立即失效重读', () => {
  const market = fixtureMarket('1.2.3');
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const manifestPath = join(market, '.claude-plugin', 'marketplace.json');

  const first = JSON.parse(runKs(['market', 'list', '--home', home, '--source', market]).stdout);
  assert.equal(first.cache.hit, false, '首跑必须 miss');
  assert.equal(first.plugins[0].version, '1.2.3');
  assert.ok(cacheFileFor(home, market), '缓存文件路径可计算');

  const second = JSON.parse(runKs(['market', 'list', '--home', home, '--source', market]).stdout);
  assert.equal(second.cache.hit, true, '指纹未变二跑命中');
  assert.equal(second.plugins[0].version, '1.2.3');

  // 发布新版插件：清单文件内容变化（mtimeNs 指纹变）→ 立即失效，新版本可见
  const bumped = JSON.parse(readFileSync(manifestPath, 'utf8'));
  bumped.plugins[0].version = '2.0.0';
  bumped.plugins[0].source = './plugins/sample-engine';
  writeFileSync(manifestPath, JSON.stringify(bumped));
  const third = JSON.parse(runKs(['market', 'list', '--home', home, '--source', market]).stdout);
  assert.equal(third.cache.hit, false, '文件变化后不许再命中陈缓存');
  assert.equal(third.plugins[0].version, '2.0.0', '新版插件立即可见，不等 TTL');

  const fourth = JSON.parse(runKs(['market', 'list', '--home', home, '--source', market]).stdout);
  assert.equal(fourth.cache.hit, true, '重读后新指纹再命中');
  assert.equal(fourth.plugins[0].version, '2.0.0');
});

test('本地清单：--refresh 强制穿透缓存（同指纹也重读）', () => {
  const market = fixtureMarket('1.2.3');
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  runKs(['market', 'list', '--home', home, '--source', market]);
  const refreshed = JSON.parse(runKs(['market', 'list', '--home', home, '--source', market, '--refresh']).stdout);
  assert.equal(refreshed.cache.refreshed, true);
  assert.equal(refreshed.cache.hit, false, '--refresh 不许吃缓存');
});

test('远端清单：TTL 内命中（离线可服务，零网络依赖证明），过期后失效去拉', () => {
  const source = 'https://cache-test.invalid/marketplace.json';
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const cacheFile = cacheFileFor(home, source);
  mkdirSync(join(home, 'state', 'market-cache'), { recursive: true });

  // 手工落一枚"刚拉取"的缓存：域名 invalid，真去 fetch 必失败——
  // 命令成功即证明 TTL 内服务自缓存、未触网
  const manifest = { name: 'remote-market', owner: { name: 'cctice' }, plugins: [{ name: 'remote-engine', version: '0.9.0', source: 'https://example.com/x/', category: 'developer-tools' }] };
  writeFileSync(cacheFile, JSON.stringify({ schemaVersion: 1, source, origin: 'https', fetchedAt: new Date().toISOString(), fingerprint: null, manifest }));
  const fresh = JSON.parse(runKs(['market', 'list', '--home', home, '--source', source]).stdout);
  assert.equal(fresh.cache.hit, true, 'TTL 内必须吃缓存（否则 invalid 域名 fetch 已炸）');
  assert.equal(fresh.market, 'remote-market');

  // TTL 过期（fetchedAt 回拨 10 分钟）→ 必须穿透去 fetch → invalid 域名拉取失败如实报错
  writeFileSync(cacheFile, JSON.stringify({ schemaVersion: 1, source, origin: 'https', fetchedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), fingerprint: null, manifest }));
  const expired = runKs(['market', 'list', '--home', home, '--source', source]);
  assert.equal(expired.status, 1, 'TTL 过期后必须重新拉取');
  assert.match(expired.stderr, /marketplace fetch failed/);
});

test('缓存坏记录当 miss 处理，不许把命令放倒', () => {
  const market = fixtureMarket('1.2.3');
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const cacheFile = cacheFileFor(home, market);
  mkdirSync(join(home, 'state', 'market-cache'), { recursive: true });
  writeFileSync(cacheFile, '{not-json');
  const run = runKs(['market', 'list', '--home', home, '--source', market]);
  assert.equal(run.status, 0, '坏缓存只当 miss，命令不倒');
  assert.equal(JSON.parse(run.stdout).cache.hit, false);
});
