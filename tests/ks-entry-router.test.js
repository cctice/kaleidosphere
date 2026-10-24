const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const entryPath = path.join(__dirname, '..', 'skills', 'ks', 'SKILL.md');
const entry = fs.readFileSync(entryPath, 'utf8');

test('ks entry declares thin routing for the implemented specialists', () => {
  assert.match(entry, /runtime-helper/);
  assert.match(entry, /project-distribution-manager/);
  assert.match(entry, /version-manager/);
  assert.match(entry, /project-rule-manager/);
  assert.match(entry, /execution-coordination/);
  assert.match(entry, /显式专项调用/);
  assert.match(entry, /不需要回经 `ks`/);
});

test('ks entry sends only explicit complex coordination requests to the coordination specialist', () => {
  assert.match(entry, /执行协调路由/);
  assert.match(entry, /显式表达需要协同/);
  assert.match(entry, /任务确有复杂协同必要性/);
  assert.match(entry, /不等于授权拆分任务/);
});

test('ks entry preserves ordinary-question zero-side-effect contract', () => {
  assert.match(entry, /普通问答：零 KS 副作用/);
  assert.match(entry, /不得调用 KS CLI/);
  assert.match(entry, /不得.*读取完整 `ks-context/);
  assert.match(entry, /不得.*创建、修改、删除 KS 状态和项目文件/);
});

test('ks entry defines the five minimal project-resolution branches', () => {
  for (const branch of [
    'A. 明确路径且唯一已登记',
    'B. 当前目录且唯一',
    'C. 新建或无候选路径',
    'D. 未登记、多候选或不可采用',
    'E. 专项无需身份'
  ]) {
    assert.match(entry, new RegExp(branch.replace(/[.]/g, '\\.'), 'u'));
  }
  assert.match(entry, /ks project resolve --path <candidate> --json/);
  assert.doesNotMatch(entry, /ks project check/);
});

test('ks entry separates specialist runtime bootstrap from unavailable self-management', () => {
  assert.match(entry, /Runtime bootstrap 与 KS 自维护/);
  assert.match(entry, /仅属于已经命中的专项/);
  assert.match(entry, /本入口不提前检查或安装 runtime/);
  assert.match(entry, /必须先转交\s*`runtime-helper`/);
  assert.match(entry, /诚实降级/);
  assert.doesNotMatch(entry, /ks --version/);
});

test('ks entry does not instruct direct state access, CLI NLP, or specialist writes', () => {
  assert.match(entry, /本入口不得：[\s\S]*直接读写 `?\$KS_HOME`?/);
  assert.match(entry, /不向 CLI 传递自然语言/);
  assert.match(entry, /也不替专项执行 `plan` 或 `apply`/);
  assert.match(entry, /未实现能力和 provider/);
  assert.match(entry, /不得把请求默认改路由为 AFK、KFC 或虚构 provider/);
});

test('ks entry delegates managed-document edits through a resolved canonical path', () => {
  const workflowPath = path.join(__dirname, '..', 'skills', 'ks', 'references', 'managed-file-access-workflow.md');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(entry, /受管文件访问工作流/);
  assert.match(workflow, /\$KS_HOME.*只能由 `ks` CLI 读写/s);
  assert.match(workflow, /用户明确要求.*编辑、修复、删除、改写或整理/s);
  assert.match(workflow, /CLI 返回的唯一文件/);
  assert.match(workflow, /必须再次通过专项 CLI `inspect`/);
  assert.match(workflow, /新章节使用 `ks spark append-section/);
});
