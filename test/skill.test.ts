import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const skill = read("skills/mizzen/SKILL.md");

interface EvalCase {
  readonly id: string;
  readonly prompt: string;
  readonly shouldTrigger: boolean;
  readonly reason: string;
}

test("the portable Skill has valid frontmatter and documents the engine workflows", () => {
  assert.ok(skill.startsWith("---\n"));
  const closing = skill.indexOf("\n---\n", 4);
  assert.ok(closing > 0);
  const frontmatter = skill.slice(4, closing);
  assert.match(frontmatter, /^name: mizzen$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.match(frontmatter, /^license: Apache-2\.0$/m);
  assert.doesNotMatch(frontmatter, /^allowed-tools:/m);
  for (const required of ["Theme-free", "Deterministic", "Add an output", "Add a fact", "npm test", "edit apply --dry-run"]) {
    assert.ok(skill.includes(required), `SKILL.md documents ${required}`);
  }
});

test("the trigger corpus has 20 unique, explained cases with balanced outcomes", () => {
  const corpus = JSON.parse(read("skills/mizzen/evals/cases.json")) as { schemaVersion: string; cases: EvalCase[] };
  assert.equal(corpus.schemaVersion, "velella.skill-evals.v1");
  assert.equal(corpus.cases.length, 20);
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 20);
  assert.equal(corpus.cases.filter((item) => item.shouldTrigger).length, 10);
  assert.equal(corpus.cases.filter((item) => !item.shouldTrigger).length, 10);
  for (const item of corpus.cases) {
    assert.ok(item.prompt.length > 20, item.id);
    assert.ok(item.reason.length > 10, item.id);
  }
});

test("the output evaluations follow the portable eval schema", () => {
  const evals = JSON.parse(read("skills/mizzen/evals/evals.json")) as {
    skill_name: string;
    evals: Array<{ id: number; prompt: string; expected_output: string; expectations: string[] }>;
  };
  assert.equal(evals.skill_name, "mizzen");
  assert.equal(evals.evals.length, 3);
  assert.equal(new Set(evals.evals.map((item) => item.id)).size, 3);
  for (const item of evals.evals) {
    assert.ok(item.prompt.length > 40);
    assert.ok(item.expected_output.length > 40);
    assert.ok(item.expectations.length >= 4);
  }
});

test("the npm package includes the Skill and excludes its evaluation data", () => {
  const manifest = JSON.parse(read("package.json")) as { files: string[] };
  assert.ok(manifest.files.includes("skills"));
  assert.ok(manifest.files.includes("!skills/*-workspace"));
  assert.ok(manifest.files.includes("!skills/**/evals"));
});

test("the install guide uses the repository's portable Skill", () => {
  const readme = read("skills/mizzen/README.md");
  assert.ok(readme.includes("npx skills add velella-sh/mizzen --skill mizzen --yes"));
  assert.ok(readme.includes("no executable Skill scripts"));
});
