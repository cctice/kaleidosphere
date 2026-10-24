# KS CLI Comparison: kaleidosphere-proj Self-Built Entry vs Fork Base cli/ks.js

> 2026-10-20，AFK 移植（plugins/afk/）配套决策记录。
> 结论先行：**不并入任何自建 CLI 代码**；自建版的 projects/spark 能力是真底座 `cli/ks.js` 的严格子集，唯一独有物是 afk 集成桥概念，已沉淀为下方对比与后续建议。

## 背景

- 参考仓（只读）：`kaleidosphere-proj/kaleidosphere/` 的 `ks.mjs` + `lib/`（391 行，零依赖自建版，29 测试）。
- 真底座：本仓 `cli/ks.js`（约 1950 行，`ks init | workspace | project | spark | coordination | chat-room | version | rules`，44 测试）。

两者同名 `ks`，但定位不同：自建版是"个人工作台统一入口"（项目宇宙 + 火花库 + afk 桥）；真底座是"KS 能力路由与用户级注册表 CLI"，读写边界 `$KS_HOME`（仅 CLI 可读写），并受 `docs/development-governance.md` 约束。

## 能力对照

| 自建版命令 | 真底座等价物 | 判断 |
|---|---|---|
| `ks projects list` | `ks project list`（含 lifecycle/tag 过滤） | 覆盖 |
| `ks projects add <name>` | `ks project create` / `ks project register`（计划-确认-落盘模型，更严） | 覆盖且更强 |
| `ks projects get <id\|alias\|name>` | `ks project search` / `ks project describe` / `ks project resolve` | 覆盖 |
| `ks projects archive <id>` | `ks project lifecycle set` | 覆盖 |
| `ks spark list` / `add` / `find` | `ks spark configure/list/find/inspect/create/append-section/check` | 覆盖且更强（真底座火花为受管 Markdown 文件，非 JSON 库） |
| `ks spark rm <id>` | 无直接等价（真底座火花模型按文件受管，删除属编辑行为，走受管文件访问工作流） | 小差异，见下 |
| `ks workflow run <task>`（afk 桥转交） | 无 | 独有，非 projects/spark 能力 |
| `ks integration show`（桥状态） | 无 | 独有，非 projects/spark 能力 |
| `ks version` | `ks version status`（version-manager 能力） | 覆盖 |

真底座另有自建版完全没有的：workspace 管理、project tag/alias/check/adopt/migrate/rules、execution-coordination 与 chat-room（可恢复执行单元）、规则沉淀与发布校验链。

## 决策与理由

1. **不并入**：自建版 projects/spark 全部被真底座以更强语义覆盖（原子写入、计划/确认边界、`$KS_HOME` 单一读写方）。并入只会引入第二套状态存储（`~/.kaleidosphere` JSON）与治理冲突，违背"宁少勿乱、真底座优先"。
2. **`spark rm` 不补**：真底座火花是受管 Markdown 文件，删除/改写属于受管文件访问工作流定义的"内容编辑"，不应在 CLI 里伪装成普通子命令；如未来需要，应按治理文档"新增 CLI 子命令先明确只读检查、计划、显式 apply 边界"另行立项。
3. **afk 桥记为后续增量**：`ks workflow run` 的本质是把任务转交给 afk-flow 技能（一次性 handoff 提示，不自动开流）。如今 AFK 已作为内置引擎随仓分发（`plugins/afk/`，`plugin.json` 声明 `integration.bundled: true`），若未来要在 `ks` 里加桥，正确形态是薄 `ks workflow` 子命令直指本仓 `plugins/afk/`，而不是移植自建版的 `integrations/afk/afk-bridge.mjs` 探测逻辑。本次不做。

## 对 AFK 移植的影响

AFK 以自包含插件结构落地 `plugins/afk/`（真底座无 plugins/ 规范，保持其 `plugin.json` 自描述契约），测试并入根 `node --test`（44 + 12 = 56 全绿）。AFK 技能不调用 `ks` CLI，不触发 KS CLI Runtime Contract 要求。
