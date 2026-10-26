const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

// 仓库元数据真实性：README 对外声称的事实必须与仓库文件一致。
// 背景：README 顶部 license 徽章曾声称 MIT 并链接到 package.json，
// 而 package.json 没有 license 字段、仓库也没有 LICENSE 文件——对外声明无处兑现。
test('license claim is backed by package.json and a LICENSE file', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.license, 'MIT', 'package.json must declare the license the README badge claims');

  assert.equal(fs.existsSync(path.join(root, 'LICENSE')), true, 'LICENSE file must exist');
  const license = read('LICENSE');
  assert.match(license, /^MIT License/, 'LICENSE must be the MIT text');
  assert.match(license, /Copyright \(c\) 2026 cctice/);
});

test('README badges link to real files and state the real version', () => {
  const readme = read('README.md');
  const pkg = readJson('package.json');

  assert.match(readme, /license-MIT-3B82F6\)\]\(https:\/\/github\.com\/cctice\/kaleidosphere\/blob\/master\/LICENSE\)/,
    'license badge must link to the LICENSE file, not to package.json');
  assert.match(readme, new RegExp(`version-${pkg.version.replace(/\./g, '\\.')}-`), 'version badge must match package.json');
});

test('afk bundled plugin declares the same license as the repository', () => {
  const pluginPackage = readJson('plugins/afk/package.json');
  assert.equal(pluginPackage.license, 'MIT');
});
