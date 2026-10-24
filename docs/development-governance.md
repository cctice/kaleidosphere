# KaleidoSphere Development Governance

本文定义 KaleidoSphere 本体开发的长期约束。`AGENTS.md` 只保留入口和不可省略的短规则；
具体执行以本文为准。

## KS CLI Runtime Contract

任何新增或修改、且会调用 `ks` CLI 的 KS skill，必须在自己的 `SKILL.md` 中包含一个
`## KS CLI Runtime Contract` 小节。`## CLI Runtime Contract` 与旧的语义等价
`## KS CLI 前置条件` 小节也可使用，但其内容同样必须满足本契约。

该小节必须明确以下行为：

1. 在执行依赖 CLI 的操作前，调用当前 plugin 随附的
   `skills/runtime-helper/scripts/ensure-runtime.js --json`。
2. 检查器负责运行 `ks --version`、比较当前 release 所需版本，并仅在命令缺失或版本不兼容时
   使用本 plugin 随附的 npm tarball 执行全局安装；不得猜测下载地址或依赖开发工作树。
3. 检查器必须在安装后精确复检；安装或复检失败时停止当前操作。
4. 不得因为 CLI 缺失、安装失败或读写失败而直接读取、修改或猜测 `~/.ks` 内的数据。

每个此类 skill 还必须随包提供其引用的安装说明（当前约定为
`references/ks-cli.md` 或 `references/ks-cli-runtime-contract.md`）。Skill 的工作流程只能
通过 `ks` CLI 查询或改变 KS 用户级状态。

## Skill 与 CLI 的边界

- Skill 负责意图识别、用户确认、SOP 和结果解释。
- `ks` CLI 负责 `~/.ks`、项目登记、计划、原子写入、校验和恢复信息。
- 不要在每个 skill 内复制 CLI 脚本、注册表读写或安装记录逻辑。
- 新增 CLI 子命令时，应先明确只读检查、计划、显式 apply 与恢复边界；不可把写操作伪装成
  普通查询。

## 受管文件访问

对 KS 管理的文档资产，统一遵循 skill 随包提供的
[`受管文件访问工作流`](../skills/ks/references/managed-file-access-workflow.md)。该流程区分
“定位和结构性写入”与“用户明确授权的内容编辑”：前者由 CLI 负责，后者仅可编辑 CLI 已返回的
唯一规范路径，并在完成后回读确认。

这不放宽 `$KS_HOME` 的边界。`~/.ks` 及其注册表、计划和状态始终只能由 CLI 读写。未来新增
会管理外部文档的 KS skill 时，必须先声明其受管资产类型、CLI 定位命令和结构性写入命令，再引用
该工作流；不得把它泛化为项目源码或任意本地文件的直接编辑许可。

## 规则沉淀

当用户做出会持续影响后续开发的决定，例如“必须”“以后都”“统一”“禁止”“默认”或“每次”，
应由项目规则能力提出沉淀建议。未经用户确认，不得自动改写项目规则文件。

规则落点按作用域区分：

- 每次开发都必须遵守的短规则：已有的 `AGENTS.md`、`CLAUDE.md` 或 `GEMINI.md` 中的原子
  引用块。
- 需要共享的完整规范：项目本体的 `docs/`。
- 仅本地开发现场需要的背景、隐性知识和交接信息：外层 `ks-context/`。
- 项目是否启用某项 KS 能力：`~/.ks`，只能通过 CLI 记录。

## 发布校验

Codex plugin 发布脚本是发布边界。它必须：

1. 从 `package.json` 读取唯一 release 版本，并打包可独立安装的 `ks` npm tarball。
2. 复制当前 release 声明的每个 skill，不允许只复制某一个默认 skill。
3. 对所有会调用 `ks` CLI 的 skill 校验 Runtime Contract 和安装说明；缺失时拒绝发布。
4. 不预建或猜测 Claude、Kiro 等其他 Agent 的交付格式。只有明确要求对应平台产物时，才使用
   对应平台的创建能力。
5. 运行发布相关测试，确认 plugin 内包含 tarball、全部 skills 和正确的 marketplace manifest。

每次要把 KaleidoSphere 本体或 marketplace 变更推送到远程时，必须先递增
`package.json` 的版本。随后重新执行发布脚本，使 tarball、Codex plugin manifest、Claude
plugin manifest 与 Claude marketplace entry 使用同一版本；不得以相同版本覆盖已发布内容。

## 版本管理能力

版本管理是可选的 KS capability，不是所有项目的默认强制项。项目未配置时，先推荐“整个项目与
主要构件共用一个版本号”的低复杂度方案；仅在用户明确提出独立发布或不同构件不同节奏时，才建议
多构件版本模型。启用后，版本规则的项目级真值位于外层
`ks-context/versioning.yaml`，并通过已有 Agent 规则文件中的原子引用块暴露给后续会话。
