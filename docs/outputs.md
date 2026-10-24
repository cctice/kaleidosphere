# 产出治理

`outputs/` 是 KaleidoSphere 的本地构建缓存，不是开发源、发布真值、用户级
`$KS_HOME` 状态目录，也不是 `local-skill-lifecycle-manager` 的
`output-products`。它必须被 Git 忽略。

## 目录

```text
outputs/
└── npm/
    └── kaleidosphere-<version>.tgz
```

- `npm/`：由 `npm pack` 生成的本地 CLI tarball 缓存。

## 真值与同步

- 本体内的 `skills/`、`mcp/`、`cli/` 和相关源码是开发真值。
- `outputs/` 只承载本地构建中间物，不直接作为开发源编辑，也不提交。
- 生成或更新产出前，先确认目标、版本边界、覆盖范围和验证方式。
- 可安装的 Agent 交付物提交到专属 marketplace 仓库。本次 Codex 交付物的发布
  真值为 `workflow-party/plugins/kaleidosphere/`。

## Agent 平台边界

**产出创建规则：不会预建或猜测 Codex、Claude、Kiro 的具体交付格式；各
平台产物只在明确要生成时，通过对应平台的创建能力产生。**

不得根据目录名、历史经验或其他 Agent 的格式猜测平台交付结构。用户明确要
为 Codex、Claude 或 Kiro 创建交付物时，必须调用该目标 Agent 对应的
plugin 或 Power 创建能力，并以该能力的当前规范生成、验证和更新产物。

这与平台打包相同：macOS 产物由 macOS 流程生成，Windows 产物由 Windows
流程生成；不能由其他平台格式手工推演替代。

## 当前范围

当前发布脚本是 `scripts/release-codex.js`，保留这个历史命令名以兼容已有调用；
`npm run release:marketplace -- --marketplace <marketplace-git-root>` 是推荐入口。
它只通过显式 CLI 参数定位 marketplace Git 根目录，不依赖 KS 或 marketplace
开发现场的目录名、绝对路径或固定 `repo/` 子目录。

一次发布会构建 npm tarball、复制 source skill，并生成两个相互独立的交付格式：

- Codex：`.agents/plugins/marketplace.json` 与插件内 `.codex-plugin/plugin.json`。
- Claude：`.claude-plugin/marketplace.json` 与插件内 `.claude-plugin/plugin.json`。

Cursor 使用 Claude marketplace 格式，因此不生成 Cursor 专用 marketplace。Codex
与 Claude 的 manifest 不互相替代，发布脚本分别维护和验证两者的 source 路径。

Kiro Power 只在有明确发布请求时新增。Kiro 使用 Agent Plugins 格式，显式执行发布时
在 `workflow-party` 根目录生成 Kiro 所需的 `plugin.json`、`skills/`、`resources/` 和
精简 README；这样 Kiro 的 GitHub 导入可以直接指向该仓库根目录。不额外猜测或生成
Kiro 专属 marketplace manifest。
