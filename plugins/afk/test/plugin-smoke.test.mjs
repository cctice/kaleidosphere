import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.join(root, "skills", "afk-flow", "scripts", "afk.js");

function run(args, env = {}) {
  const stdout = execFileSync("node", [engine, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout);
}

test("plugin.json smoke: name afk, skills dir wired, integration contract present", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(plugin.name, "afk");
  assert.match(plugin.interface.displayName, /AFK — AI Flow Kit/);
  assert.equal(plugin.skills, "./skills/");
  assert.ok(fs.existsSync(path.join(root, plugin.skills)));
  // kaleidosphere 集成契约（内置组件）
  assert.deepEqual(plugin.integration, { host: "kaleidosphere", role: "workflow-engine", bundled: true });
  assert.ok(!plugin.dependencies && !plugin.devDependencies, "must be dependency-free");
});

test("engine help works and states the no-gatekeeping principles", () => {
  const out = run(["help"]);
  assert.equal(out.name, "afk");
  assert.deepEqual(out.principles, ["local state only", "no network", "no registration", "no gatekeeping"]);
});

test("engine end-to-end: route -> continue -> complete -> stage advance", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afk-smoke-"));
  const cfg = path.join(tmp, "cfg");
  const env = { AFK_CONFIG_HOME: cfg };

  const routed = run(["route", "--root", tmp, "--material", "实现一个导出功能"], env);
  assert.equal(routed.current_stage, "implementation");
  assert.equal(routed.next_step.skill, "afk-dev");

  const cont = run(["continue", "--root", tmp], env);
  assert.equal(cont.active_step_session.step_id, "build");

  // 产物闸门：不存在的产物必须被拒（exit 非 0）
  const outPath = path.join(tmp, "build-record.md");
  let denied = false;
  try {
    run(["complete", "--root", tmp, "--output-path", path.join(tmp, "nope.md"), "--purpose", "x"], env);
  } catch {
    denied = true;
  }
  assert.ok(denied, "complete must reject a non-existent output path");

  fs.writeFileSync(outPath, "# build record\n");
  const done = run(["complete", "--root", tmp, "--output-path", outPath, "--purpose", "实现与测试记录"], env);
  assert.equal(done.current_stage, "verification");
  assert.equal(done.active_step_session, null);

  // 状态落盘且可读
  const stateFiles = fs.readdirSync(path.join(tmp, ".afk", "workflows"));
  assert.equal(stateFiles.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(tmp, ".afk", "workflows", stateFiles[0], "workflow-state.json"), "utf8"));
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].produced_by, "afk-dev");
});

test("engine steps registry: preview by default, apply only with --apply", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afk-steps-"));
  const cfg = path.join(tmp, "cfg");
  const env = { AFK_CONFIG_HOME: cfg };

  const preview = run(["steps", "add", "--stage", "design", "--step-id", "api_sketch", "--skill", "afk-flow", "--purpose", "接口草图"], env);
  assert.equal(preview.op, "add");
  assert.match(preview.note, /preview only/);
  assert.ok(!fs.existsSync(path.join(cfg, "step-registry.json")), "preview must not write the registry");

  const applied = run(["steps", "add", "--stage", "design", "--step-id", "api_sketch", "--skill", "afk-flow", "--purpose", "接口草图", "--apply"], env);
  assert.ok(applied.effective_steps.some((s) => s.step_id === "api_sketch"));

  const list = run(["steps", "list", "--stage", "design"], env);
  assert.deepEqual(list.steps.map((s) => s.step_id), ["solution_sketch", "api_sketch"]);

  // 内置步骤不可 remove
  let guarded = false;
  try {
    run(["steps", "remove", "--stage", "design", "--step-id", "solution_sketch", "--apply"], env);
  } catch {
    guarded = true;
  }
  assert.ok(guarded, "remove must refuse builtin steps");
});

test("engine stages.json skills referenced by steps all exist as afk skills", () => {
  const stages = JSON.parse(fs.readFileSync(path.join(root, "skills", "afk-flow", "references", "stages.json"), "utf8"));
  const skillsOnDisk = new Set(fs.readdirSync(path.join(root, "skills")));
  for (const def of Object.values(stages.stages)) {
    for (const step of def.steps) {
      assert.ok(skillsOnDisk.has(step.default_skill), `step ${step.step_id} references missing skill ${step.default_skill}`);
    }
  }
});
