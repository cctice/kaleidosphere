const assert = require('node:assert/strict');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('ks --help prints usage to stdout and exits 0', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const result = runKs([flag]);
    assert.equal(result.status, 0, `${flag} must exit 0, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: /, `${flag} must print the usage line`);
    assert.equal(result.stderr, '', `${flag} must not write to stderr`);
  }
});

test('usage line documents every command group, including spark', () => {
  // spark 是 README 主打能力（9 个子命令），曾被 usage 遗漏：
  // 用户拼错 spark 子命令时得到的帮助里完全没有 spark 组。
  const help = runKs(['--help']);
  for (const group of ['init', 'workspace', 'spark', 'project', 'coordination', 'chat-room', 'version']) {
    assert.ok(help.stdout.includes(`ks ${group}`), `usage must mention the "${group}" group`);
  }
  assert.match(help.stdout, /ks spark <configure\|list\|find\|inspect\|create\|append-section\|check>/);
  assert.match(help.stdout, /--home <path>/);
  assert.match(help.stdout, /--json/);
});

test('unknown command exits 1 with usage on stderr that still mentions spark', () => {
  const result = runKs(['frobnicate']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ks: Usage: /);
  assert.ok(result.stderr.includes('spark'), 'error usage must include the spark group');
  assert.equal(result.stdout, '');
});
