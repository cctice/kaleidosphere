---
name: afk-step
description: AFK skill。管理用户自定义工作流步骤：查看、预览、新增、调整、调序、重置和删除用户新增步骤；一律通过 afk steps 命令操作注册表，禁止直接编辑配置文件。
---

# afk-step — 自定义步骤管理

让用户把自己的习惯动作插进 AFK 阶段流：比如在 design 阶段加一步"画接口草图"、在 delivery 前加一步"写变更日志"。

## 使用边界

- 只管理阶段内**步骤**，不新增阶段（五阶段是通用骨架，保持稳定）。
- 用户步骤注册表是用户级配置（`AFK_CONFIG_HOME` 或 `~/.config/afk/step-registry.json`），与插件本体分离，插件升级不覆盖它。
- AI 不得直接编辑该文件，一切读写走 `afk.js steps` 命令。

## 固定流程

1. 先摸底：

```bash
node <afk>/skills/afk-flow/scripts/afk.js steps schema
node <afk>/skills/afk-flow/scripts/afk.js steps list --stage <stage>
```

2. 从用户自然语言判断操作类型：查看 / 新增 / 调整 / 调序 / 重置 / 删除。
3. 会写入配置的操作**先 preview**（不加 `--apply`）：

```bash
node .../afk.js steps add    --stage <s> --step-id <id> --skill <技能> --purpose "<用途>" [--after <锚点步骤>]
node .../afk.js steps update --stage <s> --step-id <id> [--skill <技能>] [--purpose "<用途>"]
node .../afk.js steps move   --stage <s> --step-id <id> (--before|--after) <目标步骤>
```

4. 向用户解释 preview 影响，必须说明：目标阶段、目标步骤、是新增/覆盖/调序、默认技能、产物用途、是否影响当前推进顺序。
5. 用户确认后才加 `--apply`。
6. apply 后必须再跑 `steps list --stage <stage>` 展示 effective steps。

## 命令约束

- 新增步骤必填：`stage`、`step_id`、`--skill`、`--purpose`。
- 覆盖内置步骤只需 `stage` + `step_id`（其余字段可选替换）。
- 调序只用 `--before` / `--after`。
- `steps remove` 只能删用户自增步骤；对内置步骤的定制用 `steps reset` 清除覆盖即可恢复默认。
- 每个阶段必须保留至少一个步骤（全删会让流程无法推进，引擎会拒绝）。

## 输出要求

用户可见输出包含：注册表路径、生效步骤摘要（effective steps）、每步的技能与产物用途、`produced_by: afk-step`。
