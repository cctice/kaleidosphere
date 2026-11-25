// tests/ks-spark-tags.test.js — spark 标签账+按标签过滤面（维护包二十三轮）
//
// 消化二十二轮留题："spark frontmatter 无 tags 字段（--tag 过滤是先建账再过滤
// 的题，两步分开）"。本面钉死五件事：
//   ① create --tag 落账——frontmatter 落 YAML 流式列表 tags: [..]，list 行如实回显；
//   ② list --tag 按 frontmatter tags 过滤，对账面（totalSparks/truncated）随行不省略；
//   ③ find --tag 先滤后扫——scannedSparks 反映 tag 过滤后的扫描面，不翻无关子集；
//   ④ 多 --tag 取 AND——与 find 多词 AND（十八轮）同口径；
//   ⑤ 旧火花（无 tags 字段）天然不命中 --tag 过滤——不迁移不报错，plain 面照常。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupHome(home) {
  const projectRoot = join(home, 'projects');
  const workspace = join(projectRoot, 'work');
  const sparks = join(projectRoot, 'sparks');
  mkdirSync(sparks, { recursive: true });
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  return { sparks, workspace };
}

test('ks spark create --tag writes frontmatter tags list and list rows echo them', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  setupHome(home);

  // 可多次 --tag：落账为流式列表；trim 首尾空格；重复 tag 去重保序
  const created = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', '网络拓扑账',
    '--tag', ' 网络 ', '--tag', '代理', '--tag', '网络', '--json']).stdout);
  assert.deepEqual(created.spark.tags, ['网络', '代理']);
  const content = readFileSync(created.spark.path, 'utf8');
  assert.match(content, /^tags: \[网络, 代理\]$/m);

  // 无 --tag 不落 tags 行——与旧火花同款 frontmatter（不留空账字段）
  const plain = JSON.parse(runKs(['spark', 'create', '--home', home, '--title', '无标签火花', '--json']).stdout);
  assert.deepEqual(plain.spark.tags, []);
  assert.doesNotMatch(readFileSync(plain.spark.path, 'utf8'), /^tags:/m);
});

test('ks spark list --tag filters by frontmatter tags with honest accounting', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  const { sparks } = setupHome(home);
  runKs(['spark', 'create', '--home', home, '--title', '甲', '--tag', '网络', '--json']);
  runKs(['spark', 'create', '--home', home, '--title', '乙', '--tag', '网络', '--tag', '代理', '--json']);
  runKs(['spark', 'create', '--home', home, '--title', '丙', '--json']);

  const tagged = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '网络', '--json']).stdout);
  assert.deepEqual(tagged.tags, ['网络']);
  assert.equal(tagged.totalSparks, 2);
  assert.equal(tagged.truncated, false);
  assert.deepEqual(tagged.sparks.map((spark) => spark.title).sort(), ['乙', '甲']);

  // 未过滤面回真话：tags=null（不冒充过滤过），totalSparks=全量 3
  const plain = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(plain.tags, null);
  assert.equal(plain.totalSparks, 3);

  // 空 tag 命中如实空——不编造、不回落全量
  const empty = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '不存在的标签', '--json']).stdout);
  assert.deepEqual(empty.tags, ['不存在的标签']);
  assert.equal(empty.totalSparks, 0);
  assert.deepEqual(empty.sparks, []);

  // 对账面与 --limit 同框：tag 过滤后 2 条、封顶 1 条、truncated 点名
  const capped = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '网络', '--limit', '1', '--json']).stdout);
  assert.equal(capped.totalSparks, 2);
  assert.equal(capped.sparks.length, 1);
  assert.equal(capped.truncated, true);
  assert.ok(sparks);
});

test('ks spark find --tag scans only the tagged subset and matches within it', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  const { sparks } = setupHome(home);
  // 手写落盘（与 ks-spark-filter 同款）控制 tags 与正文两条都含 tailscale
  writeFileSync(join(sparks, 'tagged-note.md'),
    '---\ntitle: Tagged Note\ndate: 2026-11-01\nscope: global\ntags: [网络, 代理]\n---\n\n# Tagged Note\n\ntailscale 拓扑账。\n');
  writeFileSync(join(sparks, 'untagged-note.md'),
    '---\ntitle: Untagged Note\ndate: 2026-11-02\nscope: global\n---\n\n# Untagged Note\n\ntailscale 发布账。\n');

  // 两条都含 tailscale——--tag 网络 先滤后扫：scannedSparks=1（不是 2）
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--tag', '网络', '--json']).stdout);
  assert.deepEqual(found.tags, ['网络']);
  assert.equal(found.scannedSparks, 1);
  assert.equal(found.matchedSparks, 1);
  assert.equal(found.sparks.length, 1);
  assert.equal(found.sparks[0].title, 'Tagged Note');
  assert.ok(found.sparks[0].snippet.includes('tailscale'));

  // 标签内无命中如实报空，对账面照常随行
  const none = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--tag', '不存在的标签', '--json']).stdout);
  assert.equal(none.scannedSparks, 0);
  assert.equal(none.matchedSparks, 0);
  assert.deepEqual(none.sparks, []);
});

test('multiple --tag values AND together (same convention as find multi-term)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  setupHome(home);
  runKs(['spark', 'create', '--home', home, '--title', '双标', '--tag', '网络', '--tag', '代理', '--json']);
  runKs(['spark', 'create', '--home', home, '--title', '单标网络', '--tag', '网络', '--json']);
  runKs(['spark', 'create', '--home', home, '--title', '单标代理', '--tag', '代理', '--json']);

  // AND：两个标签都带才命中——OR 会把子集越取越大，不合检索直觉
  const both = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '网络', '--tag', '代理', '--json']).stdout);
  assert.deepEqual(both.tags, ['网络', '代理']);
  assert.equal(both.totalSparks, 1);
  assert.equal(both.sparks[0].title, '双标');

  const one = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '网络', '--json']).stdout);
  assert.equal(one.totalSparks, 2);

  // find 同口径：AND 收窄扫描面（"标" 三条题都命中，AND 后只剩双标）
  const found = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', '标', '--tag', '网络', '--tag', '代理', '--json']).stdout);
  assert.equal(found.scannedSparks, 1);
  assert.equal(found.matchedSparks, 1);
});

test('legacy sparks without a tags field are not matched by --tag and never error', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  const { sparks } = setupHome(home);
  // 旧火花真形态：手工落盘、frontmatter 无 tags 行——零迁移，不报错
  writeFileSync(join(sparks, 'legacy-note.md'),
    '---\ntitle: Legacy Note\ndate: 2026-01-01\nscope: global\n---\n\n# Legacy Note\n\n旧火花 tailscale 内容。\n');

  const plain = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(plain.totalSparks, 1);
  assert.deepEqual(plain.sparks[0].tags, []);

  // --tag 过滤对旧火花：不命中、零报错、空命中如实
  const filtered = JSON.parse(runKs(['spark', 'list', '--home', home, '--tag', '任意', '--json']).stdout);
  assert.equal(filtered.totalSparks, 0);
  assert.deepEqual(filtered.sparks, []);

  // find 先滤后扫：旧火花被 --tag 滤出扫描面（scanned=0），plain 面内容照常命中
  const foundFiltered = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--tag', '任意', '--json']).stdout);
  assert.equal(foundFiltered.scannedSparks, 0);
  assert.equal(foundFiltered.matchedSparks, 0);
  const foundPlain = JSON.parse(runKs(['spark', 'find', '--home', home, '--query', 'tailscale', '--json']).stdout);
  assert.equal(foundPlain.scannedSparks, 1);
  assert.equal(foundPlain.matchedSparks, 1);
  assert.ok(sparks);
});

test('ks spark rejects bad --tag values instead of guessing (宁红勿默)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-spark-tags-'));
  setupHome(home);

  // 缺值/空值：宁红勿默
  const missing = runKs(['spark', 'list', '--home', home, '--tag', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--tag requires a value/);
  const blank = runKs(['spark', 'list', '--home', home, '--tag', '   ', '--json']);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /--tag must not be empty/);

  // create 面同款 + 落账破坏字符（逗号/方括号/引号/换行会破坏流式列表回读闭环）
  for (const bad of ['a,b', '[x]', 'say "hi"', "it's", 'a\nb']) {
    const result = runKs(['spark', 'create', '--home', home, '--title', `坏标签-${bad.length}`, '--tag', bad, '--json']);
    assert.equal(result.status, 1, `--tag ${JSON.stringify(bad)} must exit 1`);
    assert.match(result.stderr, /--tag must not contain commas, brackets, quotes, or line breaks/);
  }
  // 坏值零落档：以上 create 全被拒，库里不该有半条
  const plain = JSON.parse(runKs(['spark', 'list', '--home', home, '--json']).stdout);
  assert.equal(plain.totalSparks, 0);
});
