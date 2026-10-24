# KaleidoSphere Foundation And Project Assets

## 目标

新版 KaleidoSphere 是面向人机协同的、插件化的 AI 工作资源协调层，不是嵌入每个项目的文档包，也不绑定单一 Agent、工作流或供应商。

万花境借鉴操作系统在资源组织、接口抽象和协调方面的架构思想，用于组织 AI 工作资源；它不是操作系统、通用运行时、桌面环境或自治工作流引擎。

第一期先交付用户级状态边界与本地项目资产能力：`ks` CLI 和 `project-distribution-manager`。

## 唯一仓库

`kaleido-sphere` 是唯一维护的 KaleidoSphere 本体仓库。当前不配置远程，但未来直接作为公开 Git 仓使用，不再维护个人版、公司版和公开版三条长期分支产品线。

个人偏好、本机路径、账号、项目注册和连接引用均不进入仓库；它们属于用户级 `$KS_HOME` 或项目级 `ks-context/`。

## 用户级状态

`KS_HOME` 是唯一用户级状态根：

```text
macOS / Linux: ~/.ks
Windows:        %USERPROFILE%\.ks
```

环境变量 `KS_HOME` 可覆盖默认路径。Agent 和 skills 不直接读写该目录，所有读写都经由 `ks` CLI。

初始状态包含：

```text
$KS_HOME/
├── config.json
├── registry/
│   ├── workspaces.json
│   ├── projects.json
│   └── sparks.json
├── state/
└── backups/
```

JSON 是当前 CLI 的受控存储格式；CLI 对人输出使用自然语言，对 Agent 输出可使用 `--json`。

## 工作空间

受管项目根由用户配置，例如 `<projects-root>/`：

```text
work/
personal/
tooling/
playground/
temporary-proj/
sparks/
unmanaged/
```

独立 skill / skill-kit 的开发现场可以由专门的生命周期管理能力维护；后续由项目管理
能力接管其项目资产登记，但不改变该 skill 自身的生命周期职责。

`unmanaged/` 是排除根目录。它可存放 ZIP、参考材料、临时 clone 或不需要持续开发的内容；KS 不扫描、不登记、不初始化其中的项目。

`temporary-proj/` 则是受管但未完成归类的项目空间。项目只有在用户明确提出后才能迁出或重新归类。

MVP 需要通过 CLI 初始化并登记受管工作空间；具体工作空间名称、路径和项目登记属于
用户级状态，不写死在产品文档中。

## 开发现场

受管项目可以使用外层开发现场和内层项目本体的管理壳：

```text
<workspace>/<project-name>-proj/
├── <project-name>/           项目本体 Git 仓库
├── ks-context/              项目局部上下文
├── .gitignore               忽略 <project-name>/
└── .git/                    外层本地 Git
```

外层本地 Git 只追溯项目管理资料；同名项目本体目录保持原始协作仓库边界。`ks-context/project.json` 是最小身份锚点，不是全局注册表副本。

管理壳适用于需要保护原始协作仓库、但又需要保留个人项目上下文的项目。它不是所有项目的强制结构；受管项目的本体目录由登记项目名推导。项目注册表记录 `layout`，支持 `direct` 与 `worksite` 两种布局。

项目注册表还保存用于定位和路由的轻量语义索引：自由标签、别名、单行摘要和
生命周期（`active`、`paused`、`archived`）。这些字段不写入项目本体，也不等同于
Git 状态、交付工作流状态或项目知识库。项目背景、远程/账号/连接等关联信息仍属于
`ks-context/` 的后续资料能力。

## 项目来源与关联

项目的工作空间、来源、所有权、Git 身份、远程地址、SSH 连接和用途是独立且可扩展的关联，不能通过路径推断，也不预设固定账号。本地项目创建默认不要求 Git 姓名和邮箱，`ks-context/project.json` 以 `gitIdentity: null` 表示尚未设置项目远程身份；CLI 使用固定的本地专用提交作者完成 Git 初始化，且不读取全局 Git 配置。仅在配置远程、推送或需要远程身份校验时，Agent 才询问用户 Git 姓名和邮箱；两项必须显式同时传入，CLI 才写入非敏感身份元数据。注册表不保存密码、私钥或 Token。

火花以独立 Markdown 文件保存，并按日期组织在 `sparks/`。火花可关联项目，但项目不必来自火花。项目与全局知识库的关系以链接和引用形式记录，不复制或接管知识库内容。

## 人工确认边界

- AI 必须询问项目进入哪个空间，不能自行决定。
- adoption 必须把项目放入受管工作空间；不能把仍位于 `unmanaged/` 的内容标为受管项目。外部 Git 项目必须先由 CLI 生成接手计划，用户确认 `plan id` 后才能执行移动和登记。
- 移动、重命名、迁出 `temporary-proj/`、发布和删除均须由用户显式提出。
- 对 ZIP 纳入受管空间前，必须由用户决定 clone 对应远程仓库或初始化新的本地 Git 仓库。
