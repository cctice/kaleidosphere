#!/usr/bin/env node
/**
 * afk — AI Flow Kit local workflow engine.
 *
 * Self-contained: Node.js only, no external dependencies, no network access,
 * no user registration, no gatekeeping. State lives in <project>/.afk/,
 * user custom steps live in AFK_CONFIG_HOME or ~/.config/afk/.
 *
 * Commands:
 *   afk.js current  --root <dir>
 *   afk.js route    --root <dir> --material "<text>" [--title "<title>"]
 *   afk.js continue --root <dir> [--skill <skill-name>]
 *   afk.js complete --root <dir> --output-path <path> --purpose "<text>"
 *   afk.js steps schema
 *   afk.js steps list --stage <stage>
 *   afk.js steps add    --stage <s> --step-id <id> --skill <skill> --purpose "<p>" [--after <step>] [--apply]
 *   afk.js steps update --stage <s> --step-id <id> [--skill <skill>] [--purpose "<p>"] [--apply]
 *   afk.js steps move   --stage <s> --step-id <id> (--before|--after) <target> [--apply]
 *   afk.js steps remove --stage <s> --step-id <id> [--apply]   (user-added steps only)
 *   afk.js steps reset  --stage <s> --step-id <id> [--apply]   (clears user override)
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function afkStateRoot(workflowRoot) {
  return path.join(path.resolve(workflowRoot), ".afk");
}

function activeWorkflowPath(workflowRoot) {
  return path.join(afkStateRoot(workflowRoot), "active-workflow.json");
}

function workflowStatePath(workflowRoot, workflowId) {
  return path.join(afkStateRoot(workflowRoot), "workflows", workflowId, "workflow-state.json");
}

function builtinStagesPath() {
  return path.join(__dirname, "..", "references", "stages.json");
}

function userStepsPath() {
  return path.join(
    process.env.AFK_CONFIG_HOME || path.join(os.homedir(), ".config", "afk"),
    "step-registry.json"
  );
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

// ---------------------------------------------------------------------------
// Built-in stage model
// ---------------------------------------------------------------------------

function readBuiltinStages() {
  return readJsonIfExists(builtinStagesPath(), { stages: {} });
}

function stageOrder(stages) {
  return Object.keys(stages);
}

function nextStage(stages, stage) {
  const order = stageOrder(stages);
  const idx = order.indexOf(stage);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1];
}

// User step registry:
// {
//   "version": 1,
//   "changes": { "<stage>/<step_id>": { "action": "override"|"add", ...fields, "insert_after": id|null } },
//   "removed": ["<stage>/<step_id>"]
// }
function readUserSteps() {
  return readJsonIfExists(userStepsPath(), { version: 1, changes: {}, removed: [] });
}

function writeUserSteps(registry) {
  writeJsonAtomic(userStepsPath(), registry);
}

/** Compute effective steps for a stage: builtin + user overrides + user additions - removals. */
function effectiveSteps(stages, registry, stage) {
  const def = stages[stage];
  if (!def) return null;
  const removed = new Set(registry.removed || []);
  const steps = [];
  for (const step of def.steps || []) {
    if (removed.has(`${stage}/${step.step_id}`)) continue;
    const change = (registry.changes || {})[`${stage}/${step.step_id}`];
    steps.push(change && change.action === "override" ? { ...step, ...change, action: undefined, insert_after: undefined } : { ...step, origin: "builtin" });
  }
  const additions = Object.entries(registry.changes || {})
    .filter(([key, ch]) => key.startsWith(`${stage}/`) && ch.action === "add" && !removed.has(key))
    .map(([key, ch]) => ({ ...ch, stage, step_id: key.slice(stage.length + 1), origin: "user" }));
  for (const add of additions) {
    const anchor = add.insert_after || null;
    let at = steps.length;
    if (anchor) {
      const i = steps.findIndex((s) => s.step_id === anchor);
      if (i !== -1) at = i + 1;
    }
    steps.splice(at, 0, { ...add, action: undefined, insert_after: undefined });
  }
  // Honor user "move" overrides by re-anchoring overridden builtin steps.
  const moved = steps.filter((s) => s.origin === "builtin" && (registry.changes || {})[`${stage}/${s.step_id}`]?.insert_after !== undefined);
  for (const m of moved) {
    const anchor = (registry.changes || {})[`${stage}/${m.step_id}`].insert_after;
    const from = steps.indexOf(m);
    if (from === -1) continue;
    steps.splice(from, 1);
    let at = steps.length;
    if (anchor) {
      const i = steps.findIndex((s) => s.step_id === anchor);
      if (i !== -1) at = i + 1;
    }
    steps.splice(at, 0, m);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Workflow state
// ---------------------------------------------------------------------------

function readActivePointer(workflowRoot) {
  return readJsonIfExists(activeWorkflowPath(workflowRoot), { workflow_id: null });
}

function writeActivePointer(workflowRoot, workflowId) {
  writeJsonAtomic(activeWorkflowPath(workflowRoot), { workflow_id: workflowId, updated_at: nowIso() });
}

function readWorkflowState(workflowRoot, workflowId) {
  return readJsonIfExists(workflowStatePath(workflowRoot, workflowId), null);
}

function writeWorkflowState(workflowRoot, state) {
  state.workflow.updated_at = nowIso();
  writeJsonAtomic(workflowStatePath(workflowRoot, state.workflow.id), state);
}

function newWorkflowId(title) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${slugify(title)}`;
}

function createWorkflowState(title, stage) {
  return {
    version: STATE_VERSION,
    workflow: { id: newWorkflowId(title), title, created_at: nowIso(), updated_at: nowIso() },
    current_stage: stage,
    active_step_session: null,
    completed_steps: [],
    artifacts: [],
    history: [{ at: nowIso(), event: "workflow-created", stage }],
  };
}

function appendHistory(state, event, detail) {
  state.history.push({ at: nowIso(), event, ...detail });
}

// ---------------------------------------------------------------------------
// Stage classification for `route`
// ---------------------------------------------------------------------------

const ROUTE_KEYWORDS = [
  { stage: "requirement", words: ["需求", "requirement", "prd", "用户故事", "user story", "梳理", "目标"] },
  { stage: "design", words: ["设计", "design", "方案", "架构", "architecture", "schema", "技术选型"] },
  { stage: "implementation", words: ["实现", "开发", "编码", "implement", "code", "coding", "fix", "bug", "refactor", "重构", "api"] },
  { stage: "verification", words: ["测试", "验证", "自测", "test", "verify", "verification", "review", "评审", "selftest", "qa"] },
  { stage: "delivery", words: ["交付", "验收", "发布", "反馈", "deliver", "delivery", "acceptance", "release", "feedback", "收尾"] },
];

function classifyStage(material, stages) {
  const text = String(material).toLowerCase();
  let best = { stage: "requirement", score: 0 };
  for (const rule of ROUTE_KEYWORDS) {
    if (!stages[rule.stage]) continue;
    const score = rule.words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
    if (score > best.score) best = { stage: rule.stage, score };
  }
  return best.stage;
}

/** Human routing summary returned by route/continue/complete. */
function routingView(state, stages, registry) {
  const stage = state.current_stage;
  const steps = effectiveSteps(stages, registry, stage) || [];
  const done = new Set(state.completed_steps.filter((s) => s.stage === stage).map((s) => s.step_id));
  const nextStep = steps.find((s) => !done.has(s.step_id)) || null;
  const view = {
    workflow: state.workflow,
    current_stage: stage,
    stage_complete: !nextStep,
    next_stage: nextStage(stages, stage),
    active_step_session: state.active_step_session,
    next_step: nextStep ? { step_id: nextStep.step_id, skill: nextStep.default_skill, output_purpose: nextStep.output_purpose } : null,
    readiness_check: {
      rule: "a step is complete only when its output file exists on disk",
      pending_outputs: state.artifacts.filter((a) => a.stage === stage).length,
    },
    next_required_action: null,
  };
  if (state.active_step_session) {
    view.next_required_action = `continue step "${state.active_step_session.step_id}" with skill "${state.active_step_session.skill}", then record its output via complete`;
  } else if (nextStep) {
    view.next_required_action = `start step "${nextStep.step_id}" with skill "${nextStep.default_skill}"`;
  } else if (view.next_stage) {
    view.next_required_action = `stage "${stage}" done, advance to stage "${view.next_stage}"`;
  } else {
    view.next_required_action = "workflow finished, deliver results";
  }
  return view;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCurrent(args) {
  const workflowRoot = requireArg(args, "--root");
  const stages = readBuiltinStages().stages;
  const registry = readUserSteps();
  const pointer = readActivePointer(workflowRoot);
  const state = pointer.workflow_id ? readWorkflowState(workflowRoot, pointer.workflow_id) : null;
  if (!state) {
    print({ active_workflow: null, hint: "no active workflow, call route first" });
    return;
  }
  print(routingView(state, stages, registry));
}

function cmdRoute(args) {
  const workflowRoot = requireArg(args, "--root");
  const material = requireArg(args, "--material");
  const title = args["--title"] || String(material).slice(0, 60);
  const stages = readBuiltinStages().stages;
  const registry = readUserSteps();
  const pointer = readActivePointer(workflowRoot);
  const existing = pointer.workflow_id ? readWorkflowState(workflowRoot, pointer.workflow_id) : null;
  const stage = classifyStage(material, stages);
  let state;
  if (existing) {
    state = existing;
    appendHistory(state, "route-reused", { stage, material_snippet: String(material).slice(0, 120) });
  } else {
    state = createWorkflowState(title, stage);
    appendHistory(state, "route-created", { stage, material_snippet: String(material).slice(0, 120) });
  }
  writeActivePointer(workflowRoot, state.workflow.id);
  writeWorkflowState(workflowRoot, state);
  print(routingView(state, stages, registry));
}

function cmdContinue(args) {
  const workflowRoot = requireArg(args, "--root");
  const stages = readBuiltinStages().stages;
  const registry = readUserSteps();
  const pointer = readActivePointer(workflowRoot);
  const state = pointer.workflow_id ? readWorkflowState(workflowRoot, pointer.workflow_id) : null;
  if (!state) fail("no active workflow, call route first");
  if (state.active_step_session) {
    print(routingView(state, stages, registry));
    return;
  }
  const steps = effectiveSteps(stages, registry, state.current_stage) || [];
  const done = new Set(state.completed_steps.filter((s) => s.stage === state.current_stage).map((s) => s.step_id));
  const nextStep = steps.find((s) => !done.has(s.step_id));
  if (!nextStep) {
    const next = nextStage(stages, state.current_stage);
    if (!next) fail("workflow already finished, nothing to continue");
    state.current_stage = next;
    appendHistory(state, "stage-advanced", { to: next });
    return cmdContinue(args);
  }
  const skill = args["--skill"] || nextStep.default_skill;
  state.active_step_session = {
    stage: state.current_stage,
    step_id: nextStep.step_id,
    skill,
    opened_at: nowIso(),
  };
  appendHistory(state, "step-opened", { stage: state.current_stage, step_id: nextStep.step_id, skill });
  writeWorkflowState(workflowRoot, state);
  print(routingView(state, stages, registry));
}

function cmdComplete(args) {
  const workflowRoot = requireArg(args, "--root");
  const outputPath = requireArg(args, "--output-path");
  const purpose = requireArg(args, "--purpose");
  const stages = readBuiltinStages().stages;
  const registry = readUserSteps();
  const pointer = readActivePointer(workflowRoot);
  const state = pointer.workflow_id ? readWorkflowState(workflowRoot, pointer.workflow_id) : null;
  if (!state) fail("no active workflow, call route first");
  if (!state.active_step_session) fail("no active step session, call continue first");
  const resolved = path.resolve(outputPath);
  if (!fs.existsSync(resolved)) fail(`output does not exist: ${resolved}`);
  const session = state.active_step_session;
  state.artifacts.push({
    stage: session.stage,
    step_id: session.step_id,
    output_path: resolved,
    purpose,
    produced_by: session.skill,
    recorded_at: nowIso(),
  });
  state.completed_steps.push({ stage: session.stage, step_id: session.step_id, completed_at: nowIso() });
  appendHistory(state, "step-completed", { stage: session.stage, step_id: session.step_id, output_path: resolved });
  state.active_step_session = null;

  const steps = effectiveSteps(stages, registry, session.stage) || [];
  const done = new Set(state.completed_steps.filter((s) => s.stage === session.stage).map((s) => s.step_id));
  const remaining = steps.some((s) => !done.has(s.step_id));
  if (!remaining) {
    const next = nextStage(stages, session.stage);
    if (next) {
      state.current_stage = next;
      appendHistory(state, "stage-advanced", { to: next });
    } else {
      appendHistory(state, "workflow-finished", {});
    }
  }
  writeWorkflowState(workflowRoot, state);
  print(routingView(state, stages, registry));
}

// --- steps subcommands ------------------------------------------------------

const STEP_SCHEMA = {
  stage: "one of the built-in stage ids (see steps list / stages.json)",
  step_id: "stable snake_case id unique inside the stage",
  skill: "default skill invoked for this step",
  candidate_skills: "optional alternative skills",
  purpose: "what the step output is used for",
  insert_after: "anchor step id for ordering (steps add/move)",
};

function cmdSteps(args) {
  const sub = args._[0];
  const stages = readBuiltinStages().stages;
  const registry = readUserSteps();
  const apply = flag(args, "--apply");

  if (sub === "schema") {
    print({ version: 1, fields: STEP_SCHEMA, config_path: userStepsPath(), write_rule: "all writes require --apply after user confirms the preview" });
    return;
  }

  if (sub === "list") {
    const stage = requireArg(args, "--stage");
    const steps = effectiveSteps(stages, registry, stage);
    if (!steps) fail(`unknown stage: ${stage}`);
    print({ stage, next_stage: nextStage(stages, stage), steps });
    return;
  }

  if (sub === "add" || sub === "update") {
    const stage = requireArg(args, "--stage");
    const stepId = requireArg(args, "--step-id");
    if (!stages[stage]) fail(`unknown stage: ${stage}`);
    const key = `${stage}/${stepId}`;
    const builtinExists = (stages[stage].steps || []).some((s) => s.step_id === stepId);
    if (sub === "add" && (builtinExists || registry.changes[key]?.action === "add")) fail(`step already exists: ${key}`);
    if (sub === "update" && !builtinExists && registry.changes[key]?.action !== "add") fail(`step not found: ${key}`);
    const entry = {
      action: sub === "add" ? "add" : registry.changes[key]?.action === "add" ? "add" : "override",
      default_skill: args["--skill"] || registry.changes[key]?.default_skill,
      output_purpose: args["--purpose"] || registry.changes[key]?.output_purpose,
      insert_after: args["--after"] ?? registry.changes[key]?.insert_after ?? null,
    };
    if (!entry.default_skill || !entry.output_purpose) fail("--skill and --purpose are required for new fields");
    const preview = { op: sub, key, entry, apply };
    if (!apply) {
      print({ ...preview, note: "preview only, rerun with --apply to write" });
      return;
    }
    registry.changes[key] = entry;
    writeUserSteps(registry);
    print({ ...preview, effective_steps: effectiveSteps(stages, readUserSteps(), stage) });
    return;
  }

  if (sub === "move") {
    const stage = requireArg(args, "--stage");
    const stepId = requireArg(args, "--step-id");
    const anchor = args["--before"] !== undefined ? { kind: "before", id: args["--before"] } : args["--after"] !== undefined ? { kind: "after", id: args["--after"] } : null;
    if (!anchor) fail("move requires --before <step> or --after <step>");
    const key = `${stage}/${stepId}`;
    const builtinExists = (stages[stage].steps || []).some((s) => s.step_id === stepId);
    if (!builtinExists && registry.changes[key]?.action !== "add") fail(`step not found: ${key}`);
    // "before X" is expressed as "insert_after the step preceding X" when possible.
    let insertAfter = anchor.id;
    if (anchor.kind === "before") {
      const steps = effectiveSteps(stages, registry, stage) || [];
      const i = steps.findIndex((s) => s.step_id === anchor.id);
      if (i === -1) fail(`anchor not found: ${anchor.id}`);
      insertAfter = i > 0 ? steps[i - 1].step_id : null;
    }
    const prev = registry.changes[key] || { action: builtinExists ? "override" : "add", default_skill: null, output_purpose: null };
    const entry = { ...prev, insert_after: insertAfter };
    if (!entry.default_skill || !entry.output_purpose) {
      const builtin = (stages[stage].steps || []).find((s) => s.step_id === stepId);
      entry.default_skill = entry.default_skill || builtin?.default_skill;
      entry.output_purpose = entry.output_purpose || builtin?.output_purpose;
    }
    const preview = { op: "move", key, insert_after: insertAfter, apply };
    if (!apply) {
      print({ ...preview, note: "preview only, rerun with --apply to write" });
      return;
    }
    registry.changes[key] = entry;
    writeUserSteps(registry);
    print({ ...preview, effective_steps: effectiveSteps(stages, readUserSteps(), stage) });
    return;
  }

  if (sub === "remove" || sub === "reset") {
    const stage = requireArg(args, "--stage");
    const stepId = requireArg(args, "--step-id");
    const key = `${stage}/${stepId}`;
    const builtinExists = (stages[stage].steps || []).some((s) => s.step_id === stepId);
    if (sub === "remove") {
      const isUserAdded = registry.changes[key]?.action === "add";
      if (builtinExists || !isUserAdded) fail("remove only deletes user-added steps; use reset to clear an override");
      const preview = { op: "remove", key, apply };
      if (!apply) {
        print({ ...preview, note: "preview only, rerun with --apply to write" });
        return;
      }
      delete registry.changes[key];
      writeUserSteps(registry);
      print(preview);
    } else {
      if (!builtinExists || !registry.changes[key]) fail(`no user override to reset for: ${key}${!builtinExists && registry.changes[key] ? " (user-added step, use steps remove)" : ""}`);
      const preview = { op: "reset", key, apply };
      if (!apply) {
        print({ ...preview, note: "preview only, rerun with --apply to write" });
        return;
      }
      delete registry.changes[key];
      writeUserSteps(registry);
      print(preview);
    }
    return;
  }

  fail(`unknown steps subcommand: ${sub}. use schema | list | add | update | move | remove | reset`);
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[a] = true;
      else {
        args[a] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function requireArg(args, name) {
  const v = args[name];
  if (v === undefined || v === true) fail(`missing required argument ${name}`);
  return v;
}

function flag(args, name) {
  return args[name] === true;
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`afk: ${message}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  switch (cmd) {
    case "current": return cmdCurrent(args);
    case "route": return cmdRoute(args);
    case "continue": return cmdContinue(args);
    case "complete": return cmdComplete(args);
    case "steps": return cmdSteps(args);
    case "help":
    case undefined:
      print({
        name: "afk",
        usage: "afk.js <current|route|continue|complete|steps> --root <dir> [...]",
        principles: ["local state only", "no network", "no registration", "no gatekeeping"],
        engine_version: STATE_VERSION,
      });
      return;
    default: fail(`unknown command: ${cmd}`);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  classifyStage,
  effectiveSteps,
  routingView,
  createWorkflowState,
  readBuiltinStages,
  ROUTE_KEYWORDS,
};
