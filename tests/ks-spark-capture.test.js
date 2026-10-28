// tests/ks-spark-capture.test.js — 灵感捕获外部源通道（维护包四轮）
//
// 痛点：灵感捕获（火花）与外部源（IM/邮件/剪贴板）的采集通道未打通，
// 火花只能手写文件。spark capture 三通道一步入库：im/mail 文本通道 +
// 剪贴板（darwin pbpaste），source 元信息落 frontmatter 可回溯来源。
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function setupSparkDir(home) {
  const sparks = join(home, 'sparks');
  assert.equal(runKs(['init', '--home', home]).status, 0);
  assert.equal(runKs(['spark', 'configure', '--home', home, '--path', sparks]).status, 0);
  return sparks;
}

test('im/mail 通道：--text 与 --content-file 两种供给，source 落 frontmatter', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  const sparks = setupSparkDir(home);

  const fromIm = JSON.parse(runKs(['spark', 'capture', '--home', home, '--source', 'im', '--title', 'IM idea', '--text', '老板在群里说要做插件市场']).stdout);
  assert.equal(fromIm.source, 'im');
  assert.equal(fromIm.spark.source, 'im');
  assert.equal(fromIm.spark.title, 'IM idea');

  const contentFile = join(home, 'mail.txt');
  writeFileSync(contentFile, '客户邮件：希望有 Swift 绑定\n');
  const fromMail = JSON.parse(runKs(['spark', 'capture', '--home', home, '--source', 'mail', '--title', 'Mail request', '--content-file', contentFile]).stdout);
  assert.equal(fromMail.spark.source, 'mail');
  assert.match(require('node:fs').readFileSync(join(sparks, 'mail-request.md'), 'utf8'), /客户邮件：希望有 Swift 绑定/);

  const listed = JSON.parse(runKs(['spark', 'list', '--home', home]).stdout);
  assert.ok(listed.sparks.every((spark) => spark.source !== null), 'list 必须能回溯 source');
});

test('剪贴板通道：外部命令注入供给，空剪贴板/通道违约如实报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-home-'));
  setupSparkDir(home);

  const captured = JSON.parse(runKs([
    'spark', 'capture', '--home', home, '--source', 'clipboard', '--title', 'Clip note',
    '--clipboard-command', 'printf 采自剪贴板的想法'
  ]).stdout);
  assert.equal(captured.spark.source, 'clipboard');
  assert.match(require('node:fs').readFileSync(join(home, 'sparks', 'clip-note.md'), 'utf8'), /采自剪贴板的想法/);

  const empty = runKs(['spark', 'capture', '--home', home, '--source', 'clipboard', '--title', 'Empty', '--clipboard-command', 'true']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /captured content from clipboard is empty/);

  const badSource = runKs(['spark', 'capture', '--home', home, '--source', 'carrier-pigeon', '--title', 'X', '--text', 'y']);
  assert.equal(badSource.status, 1);
  assert.match(badSource.stderr, /--source must be one of: im, mail, clipboard/);

  const bothInputs = runKs(['spark', 'capture', '--home', home, '--source', 'im', '--title', 'X', '--text', 'a', '--content-file', '/etc/hostname']);
  assert.equal(bothInputs.status, 1);
  assert.match(bothInputs.stderr, /exactly one of --text or --content-file/);

  const clipboardNoOverride = runKs(['spark', 'capture', '--home', home, '--source', 'clipboard', '--title', 'X', '--text', 'a']);
  assert.equal(clipboardNoOverride.status, 1);
  assert.match(clipboardNoOverride.stderr, /do not pass --text\/--content-file/);
});
