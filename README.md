# KaleidoSphere (万花境)

[![version](https://img.shields.io/badge/version-0.4.2-22d3EE)](https://github.com/cctice/kaleidosphere) [![license](https://img.shields.io/badge/license-MIT-3B82F6)](https://github.com/cctice/kaleidosphere/blob/master/LICENSE) [![tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/cctice/kaleidosphere/tree/master/tests) [![afk engine](https://img.shields.io/badge/afk_engine-bundled-8B5CF6)](https://github.com/cctice/kaleidosphere/tree/master/plugins/afk) [![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://github.com/cctice/kaleidosphere/blob/master/package.json)

> **The Core Repository & Origin.**
> _Infinite Patterns from Simple Elements._

This is the core repository of the next generation of **KaleidoSphere**.
KaleidoSphere is a plugin-based AI work resource coordination layer for
human-agent collaboration. It organizes projects, worksites, context,
capabilities, tools, and workflow providers without binding users to one
Agent, workflow, or provider.

KaleidoSphere borrows the architectural ideas of resource organization,
stable interfaces, and coordination from operating systems. It is not an
operating system, general-purpose runtime, desktop environment, or autonomous
workflow engine.

### 🌌 Naming

- **Sphere**: A bounded and durable AI work environment for user-level project
  assets, local context, capabilities, and recoverable state where supported.
- **Kaleidoscope**: Simple, replaceable, composable units such as skills, CLI,
  MCP, providers, project rules, and local assets form adaptive work patterns.

### 🧠 Core Philosophy

- **Prism**: Refract user intent, project identity, local context, and available
  capabilities into an appropriate work environment rather than forcing every
  request through one fixed workflow.
- **Assetization**: Project identity, paths, replica relationships, and local
  context outlive a single conversation and support Agent switching.
- **Knowledge Sedimentation**: Associate reusable knowledge with suitable
  carriers without forcing transient process noise into project repositories.
- **Human in the Loop**: KaleidoSphere may identify relevant capabilities and
  suggest a safe next step, but it does not silently authorize or execute
  high-risk actions, workflow changes, migration, publication, or other
  irreversible decisions.

See [the product blueprint](docs/blueprint.md) for the architecture boundary,
roadmap, and 1.0 definition.

## 🛡️ Current Capabilities

### KS Entry And Capability Routing

`ks` is the lightweight KS entry. Under an explicit KS entry, it performs
lightweight intent recognition and routes relevant requests to an installed
KS capability. It does not automatically scan a project, load local context,
or start a workflow merely because the plugin is active.

This release routes to project asset management, global sparks, optional version
management, optional long-term project-rule management, and explicit complex
execution coordination. It does not replace delivery workflow providers such as
AFK or KFC; those providers define how work is delivered, while KS coordinates
where the work and capabilities are found.

### Project Asset Management

`project-distribution-manager` is the first KS capability. Its `ks` CLI owns
the user-level registry and supports workspace initialization, workspace
registration, project creation, planned adoption of external Git projects,
semantic project discovery, worksite compliance checks, and global spark
discovery and controlled section appends.

```text
ks init
ks workspace add
ks workspace list
ks project create
ks project register
ks project update
ks project list
ks project search
ks project tag add
ks project alias add
ks project describe
ks project lifecycle set
ks project check
ks project adopt
ks spark configure
ks spark list
ks spark find
ks spark inspect
ks spark create
ks spark append-section
ks spark check
```

### Optional Project Governance

- `version-manager` manages a user-confirmed project version model and checks
  declared version targets.
- `project-rule-manager` identifies candidate long-term project rules and
  persists them only after user confirmation.

### Explicit Execution Coordination

`execution-coordination` is available only for a user-requested, genuinely
complex collaboration. It maintains a single recoverable execution unit per
task anchor, controlled external `ks-coordination/` projections, and revision-
bound room operations. It does not automatically split work, create manual
sub-sessions, or replace a runtime's native sub-agent capability.

```text
ks coordination open
ks coordination find
ks coordination resume
ks coordination archive
ks chat-room open
ks chat-room append
ks chat-room split
ks chat-room archive
```

`$KS_HOME` defaults to `~/.ks` on macOS and Linux, and `%USERPROFILE%\\.ks`
on Windows. Only the CLI may read or write it.

### Outputs

`outputs/` is a Git-ignored local build cache. Distributable Agent artifacts
are published to their dedicated marketplace repository.

> Platform artifacts are never prebuilt or guessed. They are created only when
> explicitly requested, through the target Agent's own plugin or Power creation
> capability.

See [Output Governance](docs/outputs.md).

## 🌌 Repository Architecture

```text
KaleidoSphere
├── cli/                  ks CLI
├── skills/               KS source capabilities
├── plugins/              Bundled provider plugins (AFK workflow engine)
├── mcp/                  Future service integrations
├── docs/                 Design and maintenance documentation
├── outputs/              Local ignored build cache
└── $KS_HOME              User-level registry and recoverable state
```

## 🚀 Development Workspace

Managed projects use a development worksite that keeps the original repository
and KS-specific local context separate:

```text
<workspace>/<project-name>-proj/
├── <project-name>/           Original project repository
├── ks-context/              Local project context
├── .gitignore               Ignores <project-name>/
└── .git/                    Outer worksite Git history
```

The worksite root must use the `<project-name>-proj` suffix. The project
repository directory is derived from the registered project name, so its Git
root and remote naturally keep the same identity.

## 🛠 Development

Run the automated tests:

```bash
npm test
```

For output, installation, synchronization, or packaging work, read
[Output Governance](docs/outputs.md) first.

## AFK 工作流引擎（内置）

KaleidoSphere bundles **AFK — AI Flow Kit** as its workflow-engine provider
under [`plugins/afk/`](plugins/afk/). AFK routes a coding task through five
stages (requirement, design, implementation, verification, delivery), keeps
per-project local state in `.afk/`, and enforces one hard invariant: a step is
complete only when its output file exists on disk. It is local-only, zero
dependency, and replaces no KS capability — KS coordinates where work and
capabilities are found, AFK delivers the workflow.

See the [AFK README](plugins/afk/README.md) for usage, and
[the KS CLI comparison note](docs/design/20261020-ks-cli-comparison.md) for the
porting decision record.

[中文文档](README_CN.md)
