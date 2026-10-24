---
name: afk-flow
description: AFK 主入口技能。通用任务流路由：把任意编码任务按 requirement → design → implementation → verification → delivery 五阶段流转，本地记录状态与产物，零外部依赖、零把关人。
---

# afk-flow — 通用任务流路由

AFK（AI Flow Kit）的主引擎。它回答一个问题：**这个任务现在该干什么，下一步是什么。**

- 状态写在工作目录 `.afk/`（active-workflow.json + workflows/<id>/workflow-state.json）
- 用户自定义步骤写用户级配置 `AFK_CONFIG_HOME` 或 `~/.config/afk/`
- 不联网、不注册、不发送任何遥测：一切判断只依赖本地状态与磁盘产物

## 阶段模型

`requirement → design → implementation → verification → delivery`

每阶段含若干步骤（见 `references/stages.json`），核心不变量：

> **一个步骤只有在它的产出文件真实存在于磁盘上，才算完成。**

## 入口命令

```bash
node <afk>/skills/afk-flow/scripts/afk.js current  --root <项目根>
node <afk>/skills/afk-flow/scripts/afk.js route    --root <项目根> --material "<任务描述>" [--title "<标题>"]
node <afk>/skills/afk-flow/scripts/afk.js continue --root <项目根> [--skill <技能名>]
node <afk>/skills/afk-flow/scripts/afk.js complete --root <项目根> --output-path <产物路径> --purpose "<用途>"
node <afk>/skills/afk-flow/scripts/afk.js steps list --stage <阶段>
```

## 固定流程

1. `current` 先看有没有活动 workflow；没有则 `route` 用自然语言材料建流（阶段由关键词自动定位，也可手动指定起点）。
2. 读取路由结果里的 `current_stage`、`active_step_session`、`next_step`、`readiness_check`、`next_required_action`，按 `next_required_action` 行动。
3. 存在活动 session 时继续同一技能干活，产出落盘后 `complete --output-path` 登记（`complete` 会校验文件存在，不存在即失败——这是防"口头完成"的硬闸）。
4. 阶段步骤全部登记后自动进入下一阶段；`delivery` 结束即 workflow 完成。
5. 只是定位或检查时保持只读，不调用 `complete`。

## 路由判定

`route` 用双语关键词给材料定位阶段：需求/requirement/prd → requirement；设计/design/架构/方案 → design；实现/code/fix/refactor → implementation；测试/verify/review/自测 → verification；交付/验收/feedback → delivery。同一工作目录同时只有一个活动 workflow，重复 `route` 复用而非新建。

## 输出要求

对用户可见的每次流转结论必须包含：当前阶段、下一步（步骤+技能）、产物路径与用途、readiness_check 状态。登记产物时带 `produced_by: <技能名>`。

## 与其他 afk 技能的关系

- `afk-dev`：implementation 阶段主力（开发执行+自代码评审）
- `afk-verify`：verification 阶段主力（自动验证+反馈闭环）
- `afk-step`：改步骤清单（不新增阶段），见对应 SKILL.md

集成方（如宿主协调层）可通过 plugin.json 的 `integration` 字段识别本插件角色。
