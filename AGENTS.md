# KaleidoSphere Project Rules

允许 AI 自动提交：是（仅限本练习/个人项目）。

该许可仅解除 KFC 的 Git commit guard；不豁免上报、测试、审查或其他质量门禁。

发布、打包、同步或 marketplace 相关工作先阅读 `../ks-context/release/codex-plugin.md`。

所有 KaleidoSphere 自身开发还必须遵守
[`docs/development-governance.md`](docs/development-governance.md)。特别是：任何调用
`ks` CLI 的 skill 必须包含 KS CLI Runtime Contract；不得直接读写 `~/.ks`；发布前必须
通过对应的发布校验与测试。

任何将推送到 KaleidoSphere 本体或 marketplace 远程仓库的变更，必须先递增
`package.json` 的版本；随后重新生成 marketplace 产物，确认 CLI tarball、Codex manifest
和 Claude manifest 使用同一版本，再提交和推送。
