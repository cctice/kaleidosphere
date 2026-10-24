# SECURITY-CUTS — 蒸馏剔除清单

AFK 从前身工作流插件蒸馏而来。判断标准只有一条：**保留"让 AI 干活更顺的通用工作流机器"，剔除一切绑定特定使用环境的角色、门禁与流程控制。** 本文件逐条记录剔除内容，作为自包含与通用化的证明。逐条核对基线：前身插件的全部 skill 目录、路由脚本、参考目录与清单文件。

## 一、剔除的技能整类（前身共 15 个 skill → AFK 保留 4 个）

| # | 剔除的前身组件 | 剔除原因 | 归宿 |
|---|---|---|---|
| 1 | 需求评审 worker（requirement-review） | 评审准入角色：判定"是否可进入下一阶段"的组织流程控制 | 并入 `afk-flow` 的通用 readiness_check（只看产物是否落盘，不看谁批准） |
| 2 | 轻量 PRD worker（lightweight-prd） | 固定文档模板绑定特定交付流程 | 精华为"意图+验收标准"清单，并入 `afk-flow` requirement 阶段 |
| 3 | 详细设计 worker（detailed-design） | 同上，模板化文档产出 | 精华为"方案草图"，并入 `afk-flow` design 阶段 |
| 4 | 任务拆分 worker（task-breakdown） | 绑定多角色任务包分发流程 | 不保留：AFK 面向单 AI 会话自流转 |
| 5 | 开发记录 worker（development-record） | 与开发执行分离的组织性记录岗 | 并入 `afk-dev` 的产物登记要求 |
| 6 | 运行时自测录制 worker（runtime-selftest-recorder） | 与自动验证重复的记录岗 | 并入 `afk-verify` 验证记录 |
| 7 | 安全评审 worker（security-review） | 作为**必走门禁**存在（"固定执行或记录无法执行原因"） | 降级为 `afk-dev` 自评审清单中的"安全基线"检查项——是建议动作，不是门禁 |
| 8 | 复核准备打包 worker（review-readiness-packager） | 为"人工复核节点"准备材料的门禁岗 | 并入 `afk-verify` 的 escalated 状态与 `delivery` 摘要 |
| 9 | 验收指南 worker（acceptance-guide） | 面向外部验收方的文档岗 | 并入 `afk-flow` delivery 阶段的交付摘要 |
| 10 | hook 助手 + 其 JS 脚本 | 宿主事件挂钩，绑定特定宿主行为 | 不保留：AFK 以 SKILL.md + 单脚本自包含 |
| 11 | 双格式插件壳（.claude-plugin/、.codex-plugin/） | 多宿主适配壳 | 不保留：单 plugin.json 自描述 |
| 12 | worker 打包注销工具（package-workers.js 的 preview/plan/apply 注销流） | 用于从包里移除组织规定 worker | 不保留：AFK 无组织规定的 worker |

**保留并蒸馏的 4 个**：flow-router → `afk-flow`；custom-step-manager → `afk-step`；automated-verification-runner + acceptance-feedback-resolution → `afk-verify`；development-execution + code-review → `afk-dev`。

## 二、剔除的机制与字段（引擎层）

| # | 剔除项 | 出处 | 替代 |
|---|---|---|---|
| 1 | `flow_node_check` 流程节点检查语义（"节点是否放行"） | 路由器返回字段 | 改名 `readiness_check`，且语义单一化：只校验产物文件存在，无放行方概念 |
| 2 | worker 注册表 / 内置技能注册表（builtin-skill-registry、worker-catalog） | references/*.yaml、*.json | 单一 `stages.json`（阶段×步骤×技能映射），无"注册/注销 worker"概念 |
| 3 | 固定 worker 的哈希确认注销流程（preview → --plan → --apply 移除包级 worker） | 路由器 SKILL.md | 无包级 worker 可注销；用户步骤用 `afk-step` 的 preview → `--apply` |
| 4 | 依赖包检查命令（`dependencies --check-only`） | 入口 CLI | 无依赖可查（零 npm 依赖，自包含） |
| 5 | 8 阶段组织流程（requirement→…→acceptance-guide→acceptance-feedback） | stage-steps.yaml | 5 阶段通用骨架（requirement→design→implementation→verification→delivery），每阶段含步骤而非整段文档岗 |
| 6 | `KFC` 全部品牌标识与配置路径（`.kfc/`、`~/.config/kfc-plugin/`、`KFC_CONFIG_HOME`） | 全部文件 | `afk` 品牌：`.afk/`、`~/.config/afk/`、`AFK_CONFIG_HOME` |
| 7 | "个人/公司双轨说明"类边界条款（"不读取公司注册表""入口上报"等表述） | 多个 SKILL.md | 单一设计立场：本地优先、零依赖、无门禁、如实报告 |

## 三、剔除的语汇黑名单

以下词在整个 AFK 仓库（skill 正文、脚本、清单）中不得出现，测试用例强制：

`公司` `员工` `部门` `审批` `门禁` `准入` `工单` `质量门` `上报` `注册（用户登记义）` `kfc` `KFC`

与"审查/复核"相关的表述一律改写为 AI 自身的动作（自评审、自测）或中性的用户动作（确认 preview），不引入任何人扮演的把关角色。

## 四、保留的精华（对照证明通用化≠阉割）

1. **产物闸门**：`complete` 校验输出文件存在才放行步骤（前身核心不变量，原样保留）。
2. **preview → apply 二段写**：用户级配置一律先预览后落盘（源自步骤管理器，原样保留）。
3. **本地状态机**：`active-workflow.json` + `workflows/<id>/workflow-state.json` 的双层状态布局（沿用结构，简化为单活动流）。
4. **阶段关键词路由**：双语关键词把自然语言任务定位到阶段（沿用思路，词汇表通用化）。
5. **修复循环上限**：验证失败最多 3 轮"定位→最小修复→复跑"，收敛不了如实挂起（新增固化，源自验证岗实践）。
6. **如实报告铁律**：没跑=没通过、不编造结果（源自开发执行岗，升格为插件级立场）。

## 五、自包含声明

- 引擎 `afk.js` 仅用 Node 标准库（fs/os/path），无 npm 依赖，无网络调用，无 postinstall 脚本。
- 无任何外部网络引用；全部参考数据（阶段定义）随包分发（`skills/afk-flow/references/stages.json`）。
- 以 kaleidosphere 内置组件形式分发（`plugin.json` → `integration.bundled: true`），目录自包含：拷出 `plugins/afk/` 即可独立运行。
