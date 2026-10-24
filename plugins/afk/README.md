# AFK — AI Flow Kit

> **AFK** 是个双关：
> - **AI Flow Kit** —— 让 AI 干活更"顺"（flow）的一套工作流工具箱；
> - **Away From Keyboard** —— 人可以离开键盘了，AI 自己按阶段流转、自己验证、自己修，收敛了再叫你。

## 它解决什么问题

把一个编码任务丢给 AI，最常见的翻车不是"不会写"，而是**没有节奏**：跳过设计直接写、写完不测、测挂了硬说通过、改到一半就宣布完成。AFK 给 AI 装一个本地任务流引擎，把活儿钉在五条轨道上：

```
requirement → design → implementation → verification → delivery
（意图澄清）  （方案草图） （最小步幅 TDD）  （自测自修闭环）  （收尾与反馈回流）
```

核心不变量只有一条，但是是硬的：

> **一个步骤只有在它的产出文件真实存在于磁盘上，才算完成。**

`complete` 命令会校验产物路径存在，不存在直接失败——"口头完成"过不了闸。

## 三分钟上手

```bash
# AFK 是 kaleidosphere 仓的内置组件（plugins/afk/），随主仓获得
AFK=<kaleidosphere 仓库路径>/plugins/afk
cd $AFK && node --test                 # 本地验收，全绿再往下走
```

在你的项目根目录（任意文件夹均可）：

```bash
AFK=<afk 仓库路径>

# 1. 建流：用自然语言描述任务，阶段自动定位
node $AFK/skills/afk-flow/scripts/afk.js route --root . --material "给 CLI 加一个导出 JSON 的功能"

# 2. 看 AI 该干什么：next_required_action 告诉你下一步
node $AFK/skills/afk-flow/scripts/afk.js current --root .

# 3. 开一个步骤会话，让对应技能干活（afk-dev / afk-verify ...）
node $AFK/skills/afk-flow/scripts/afk.js continue --root .

# 4. 产出落盘后登记（产物不存在会失败——这就是闸门）
node $AFK/skills/afk-flow/scripts/afk.js complete --root . \
  --output-path ./docs/export-design.md --purpose "导出功能方案草图"
```

状态全在 `<项目>/.afk/` 下（JSON，人可读可 diff），删掉即重来。自定义步骤存在 `AFK_CONFIG_HOME`（默认 `~/.config/afk/`），与插件本体分离，升级互不覆盖。

## 技能表

| 技能 | 职责 | 一句话 |
|---|---|---|
| `afk-flow` | 主入口 / 任务流路由 | 回答"现在该干什么、下一步是什么"，产物落盘才算完成 |
| `afk-step` | 自定义步骤管理 | 往阶段里插自己的步骤，preview → 确认 → apply，禁止手改配置 |
| `afk-verify` | 自动验证 + 反馈闭环 | 探测验证入口、跑、修（最多 3 轮）、复跑；绝不编造通过 |
| `afk-dev` | 开发执行 + 自评审 | 最小步幅 TDD 写代码，写完对 diff 做有依据的自评审 |

在 ZCode / Claude Code 等支持 skills 目录的宿主里，直接以 `/afk-flow ...`、`/afk-verify ...` 方式调用。本插件以**内置组件**身份随 kaleidosphere（新万花镜）分发，宿主集成方可读 `plugin.json` 的 `integration` 字段（`{ "host": "kaleidosphere", "role": "workflow-engine", "bundled": true }`）识别它为可嵌入的工作流引擎。

## 设计立场

- **本地优先**：状态、注册表全在本地文件；不联网、不上报、不要求注册。
- **零依赖**：引擎是单个 Node 脚本（`afk.js`），无 npm 依赖，无 postinstall。
- **无门禁**：没有角色、审批、准入检查——判断只依赖"产物在不在磁盘上"这一客观事实。
- **如实报告**：验证没跑就是没跑，修不动就写明卡点，不烧 token 硬试。

## 与"前身理念"的关系

AFK 蒸馏自一套个人工作流插件在真实项目里打磨出的方法论（阶段流转、产物闸门、preview/apply 二段写、自测自修循环），去掉了所有绑定特定使用环境的角色与流程控制，只留"让 AI 干活更顺的通用工作流机器"，向那套前身的方法论致敬。具体保留了什么、剔除了什么，见 [SECURITY-CUTS.md](./SECURITY-CUTS.md)。

## License

MIT
