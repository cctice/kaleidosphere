// tests/ks-usage-surface.test.js — CLI 路由面与 USAGE 一致性门（维护包三轮：清单强化）
//
// USAGE 字符串是用户看到的命令面，路由 if 链是实际实现的命令面——
// 两边手工维护必然漂移：新增子命令忘了进 usage，或 usage 宣称了
// 不存在的子命令。本门把两边钉死：路由有的 usage 必须有，usage 有
// 的路由必须有（分组对齐，含负向兜底）。
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'cli', 'ks.js'), 'utf8');

// USAGE 常量在源码中（与 --help 输出同源）
const usageMatch = source.match(/const USAGE = '([^']+)'/);
assert.ok(usageMatch, 'cli/ks.js 未找到 USAGE 常量');
const usage = usageMatch[1];

// 从 usage 提取：<group> <a|b|c> 形态
const usageGroups = {};
for (const m of usage.matchAll(/([\w-]+) <([a-z|-]+)>/g)) {
  if (m[1].startsWith('-')) continue; // [--home <path>] 等全局选项非命令分组
  usageGroups[m[1]] = m[2].split('|');
}

// 从路由 if 链提取：同一行内 command === 'group' 配合一个或多个
// args[1] === 'sub'（含 (a || b) 复合形态，如 coordination find|resume）
const routed = {};
for (const line of source.split('\n')) {
  const group = line.match(/command === '([\w-]+)'/);
  if (!group) continue;
  for (const sub of line.matchAll(/args\[1\] === '([a-z-]+)'/g)) {
    (routed[group[1]] ??= new Set()).add(sub[1]);
  }
}

test('USAGE 分组枚举与实际路由一一对应（双向）', () => {
  assert.ok(Object.keys(usageGroups).length >= 5, 'USAGE 分组解析异常');

  for (const [group, subs] of Object.entries(usageGroups)) {
    const routedSubs = routed[group] ?? new Set();
    for (const sub of subs) {
      assert.ok(
        routedSubs.has(sub),
        `USAGE 宣称 '${group} ${sub}' 但路由未实现——虚假命令面`,
      );
    }
    for (const sub of routedSubs) {
      assert.ok(
        subs.includes(sub),
        `路由实现了 '${group} ${sub}' 但 USAGE 未列出——用户不可发现`,
      );
    }
  }
});

test('路由中出现的分组都出现在 USAGE 总纲里', () => {
  for (const group of Object.keys(routed)) {
    assert.ok(
      usage.includes(`ks ${group} `) || usage.includes(`| ${group} `),
      `分组 '${group}' 有路由但 USAGE 总纲未提及`,
    );
  }
});

test('usage 与 --help 实际输出一致（同一常量渲染）', () => {
  // spawn 校验会拖慢测试；USAGE 即 --help 的输出体（ks-help.test 已覆盖
  // 退出码），这里只做静态一致性：USAGE 必须以 'Usage: ks ' 开头且
  // 包含 --home/--json 两个全局选项声明。
  assert.ok(usage.startsWith('Usage: ks '), 'USAGE 应以 "Usage: ks " 开头');
  assert.ok(usage.includes('--home'), 'USAGE 缺 --home 全局选项');
  assert.ok(usage.includes('--json'), 'USAGE 缺 --json 全局选项');
});
