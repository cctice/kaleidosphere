import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(root, "skills");
const EXPECTED_SKILLS = ["afk-flow", "afk-step", "afk-verify", "afk-dev"];

// 语汇黑名单：SECURITY-CUTS.md 第三节，skill 正文不得出现
const FORBIDDEN = ["公司", "员工", "部门", "审批", "门禁", "准入", "工单", "质量门", "上报", "kfc", "KFC"];

function readSkill(name) {
  const file = path.join(skillsDir, name, "SKILL.md");
  return { file, text: fs.readFileSync(file, "utf8") };
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

test("all four expected skills ship a SKILL.md", () => {
  for (const name of EXPECTED_SKILLS) {
    assert.ok(fs.existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md missing`);
  }
  const onDisk = fs.readdirSync(skillsDir).filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory());
  assert.deepEqual([...onDisk].sort(), [...EXPECTED_SKILLS].sort(), "skills dir must contain exactly the four afk skills");
});

test("every SKILL.md has frontmatter with non-empty name and description", () => {
  for (const name of EXPECTED_SKILLS) {
    const fm = parseFrontmatter(readSkill(name).text);
    assert.ok(fm, `${name}: no frontmatter block`);
    assert.equal(fm.name, name, `${name}: frontmatter name must match directory`);
    assert.ok(fm.description && fm.description.length >= 10, `${name}: description too short`);
    assert.ok(fm.description.length <= 300, `${name}: description too long (>300 chars)`);
  }
});

test("every SKILL.md body has an H1 title mentioning afk", () => {
  for (const name of EXPECTED_SKILLS) {
    const body = readSkill(name).text.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.match(body, /^#\s+afk/m, `${name}: missing H1 starting with afk`);
    assert.ok(body.includes("afk"), `${name}: body must reference the afk brand`);
  }
});

test("every SKILL.md declares produced_by output convention", () => {
  for (const name of EXPECTED_SKILLS) {
    assert.ok(readSkill(name).text.includes("produced_by"), `${name}: missing produced_by output convention`);
  }
});

test("no company/gatekeeping vocabulary in any SKILL.md (SECURITY-CUTS blacklist)", () => {
  for (const name of EXPECTED_SKILLS) {
    const text = readSkill(name).text;
    for (const word of FORBIDDEN) {
      assert.ok(!text.includes(word), `${name}: forbidden word "${word}" found`);
    }
  }
});

test("main entry skill afk-flow documents the five universal stages", () => {
  const text = readSkill("afk-flow").text;
  for (const stage of ["requirement", "design", "implementation", "verification", "delivery"]) {
    assert.ok(text.includes(stage), `afk-flow: stage ${stage} not documented`);
  }
});

test("stages.json reference is valid JSON covering all five stages", () => {
  const stages = JSON.parse(fs.readFileSync(path.join(skillsDir, "afk-flow", "references", "stages.json"), "utf8"));
  assert.deepEqual(Object.keys(stages.stages), ["requirement", "design", "implementation", "verification", "delivery"]);
  for (const [id, def] of Object.entries(stages.stages)) {
    assert.ok(Array.isArray(def.steps) && def.steps.length >= 1, `${id}: must keep at least one step`);
    for (const step of def.steps) {
      assert.ok(step.step_id && step.default_skill && step.output_purpose, `${id}: step missing id/skill/purpose`);
    }
  }
});
