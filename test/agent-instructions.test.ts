import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourcePos } from "../src/contracts/index.ts";
import { parseAgentInstructions } from "../src/content/agent-instructions.ts";

const F = "guide/install.md";

/** A page as the front-matter loader would split it, plus the slice between the fences. */
function page(...lines: string[]): { source: string; yaml: string } {
  return { source: ["---", ...lines, "---", "# Install", ""].join("\n"), yaml: lines.join("\n") };
}

/** The span of `needle` in `source`, for comparing with a diagnostic's position. */
function at(source: string, needle: string): SourcePos {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `the source contains ${needle}`);
  const before = source.slice(0, index).split("\n");
  const line = before.length;
  const column = before[before.length - 1]!.length + 1;
  return { file: F, line, column, endLine: line, endColumn: column + needle.length - 1 };
}

test("a page without an agent block is unaffected", () => {
  const { source, yaml } = page("title: Install", "description: How to install");
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics, []);
  assert.equal(source.includes("agent"), false);
});

test("empty YAML is a page without an agent block", () => {
  const result = parseAgentInstructions("", F);
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics, []);
});

test("front matter that is not a mapping has no agent block and no diagnostic of its own", () => {
  const result = parseAgentInstructions("- one\n- two\n", F);
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics, []);
});

test("agent.rules is a list of strings and agent.owner is a string", () => {
  const { yaml } = page(
    "title: Install",
    "agent:",
    "  owner: docs-team",
    "  rules:",
    "    - Never change the version table by hand",
    "    - Update the screenshots",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, {
    owner: "docs-team",
    rules: ["Never change the version table by hand", "Update the screenshots"],
  });
  assert.deepEqual(result.diagnostics, []);
});

test("every accepted key is read, and edit: false stays false", () => {
  const { yaml } = page(
    "agent:",
    "  edit: false",
    "  source: src/version.ts",
    "  notes: Change the constant, not the page.",
    "  owner: platform",
    "  rules: [\"Run the tests\"]",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, {
    edit: false,
    source: "src/version.ts",
    notes: "Change the constant, not the page.",
    owner: "platform",
    rules: ["Run the tests"],
  });
  assert.deepEqual(result.diagnostics, []);
});

test("an empty rules list is kept", () => {
  const result = parseAgentInstructions("agent:\n  rules: []\n", F);
  assert.deepEqual(result.agent, { rules: [] });
  assert.deepEqual(result.diagnostics, []);
});

test("agent: with no value means there is no block", () => {
  const result = parseAgentInstructions("title: Install\nagent:\n", F);
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics, []);
});

test("an explicit null agent, or a key with no value, is unset", () => {
  assert.deepEqual(parseAgentInstructions("agent: ~\n", F), { agent: {}, diagnostics: [] });
  const result = parseAgentInstructions("agent:\n  owner:\n  rules: []\n", F);
  assert.deepEqual(result.agent, { rules: [] });
  assert.deepEqual(result.diagnostics, []);
});

test("agent: {} means there is no block", () => {
  const result = parseAgentInstructions("agent: {}\n", F);
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics, []);
});

test("unknown keys are warnings at the key, with its line in the file", () => {
  const { source, yaml } = page(
    "title: Install",
    "agent:",
    "  owner: docs-team",
    "  rule: Never change the version table",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, { owner: "docs-team" });
  assert.equal(result.diagnostics.length, 1);
  const d = result.diagnostics[0]!;
  assert.equal(d.id, "agent.unknown-key");
  assert.equal(d.severity, "warning");
  assert.match(d.message, /`rule`/);
  assert.deepEqual(d.pos, at(source, "rule"));
  assert.deepEqual(d.pos, { file: F, line: 5, column: 3, endLine: 5, endColumn: 6 });
});

test("every unknown key is reported once, in document order", () => {
  const { yaml } = page("agent:", "  zebra: 1", "  owner: team", "  apple: 2");
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.diagnostics.map((d) => d.message), [
    "Unknown key `zebra` in the `agent` block.",
    "Unknown key `apple` in the `agent` block.",
  ]);
  assert.equal(result.diagnostics[0]!.pos?.line, 3);
  assert.equal(result.diagnostics[1]!.pos?.line, 5);
});

test("wrong types are errors at the key, one diagnostic per key", () => {
  const { source, yaml } = page(
    "agent:",
    "  edit: \"yes\"",
    "  source: 3",
    "  notes: [a]",
    "  owner: true",
    "  rules: not-a-list",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, {});
  assert.equal(result.diagnostics.length, 5);
  for (const d of result.diagnostics) {
    assert.equal(d.id, "agent.invalid-type");
    assert.equal(d.severity, "error");
  }
  assert.deepEqual(result.diagnostics.map((d) => d.message), [
    "`agent.edit` must be a boolean.",
    "`agent.source` must be a string.",
    "`agent.notes` must be a string.",
    "`agent.owner` must be a string.",
    "`agent.rules` must be a list of strings.",
  ]);
  assert.deepEqual(result.diagnostics.map((d) => d.pos), [
    at(source, "edit"),
    at(source, "source"),
    at(source, "notes"),
    at(source, "owner"),
    at(source, "rules"),
  ]);
});

test("a non-string rule is reported at the entry and the other rules are kept", () => {
  const { source, yaml } = page(
    "agent:",
    "  rules:",
    "    - Keep the table sorted",
    "    - 42",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, { rules: ["Keep the table sorted"] });
  assert.equal(result.diagnostics.length, 1);
  const d = result.diagnostics[0]!;
  assert.equal(d.id, "agent.invalid-type");
  assert.match(d.message, /Every entry in `agent\.rules` must be a string/);
  assert.deepEqual(d.pos, at(source, "42"));
});

test("a misspelled key and a wrong type on the same block are both reported", () => {
  const { yaml } = page("agent:", "  edit: nope", "  rulez: []");
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, {});
  assert.deepEqual(result.diagnostics.map((d) => d.id), [
    "agent.invalid-type",
    "agent.unknown-key",
  ]);
});

test("an agent value that is not a mapping is an error at the agent key", () => {
  for (const value of ["docs-team", "42", "[a, b]"]) {
    const { source, yaml } = page("title: Install", `agent: ${value}`);
    const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
    assert.deepEqual(result.agent, {});
    assert.equal(result.diagnostics.length, 1);
    const d = result.diagnostics[0]!;
    assert.equal(d.id, "agent.not-a-mapping");
    assert.equal(d.severity, "error");
    assert.match(d.message, /must be a YAML mapping/);
    assert.deepEqual(d.pos, at(source, "agent"));
    assert.deepEqual(d.pos, { file: F, line: 3, column: 1, endLine: 3, endColumn: 5 });
  }
});

test("invalid YAML in the slice is one error and no block", () => {
  const result = parseAgentInstructions("agent:\n  rules: [unclosed\n", F);
  assert.deepEqual(result.agent, {});
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.id, "agent.invalid-yaml");
  assert.equal(result.diagnostics[0]!.severity, "error");
  assert.equal(result.diagnostics[0]!.pos?.file, F);
});

test("the firstLine option is the only line offset; the default slices from line 1", () => {
  const yaml = "agent:\n  nope: 1\n";
  const bare = parseAgentInstructions(yaml, F);
  assert.equal(bare.diagnostics[0]!.pos?.line, 2);
  assert.equal(bare.diagnostics[0]!.pos?.column, 3);

  const inFile = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.equal(inFile.diagnostics[0]!.pos?.line, 3);
  assert.equal(inFile.diagnostics[0]!.pos?.column, 3);
});

test("other front-matter keys are read past, not validated here", () => {
  const { yaml } = page(
    "title: Install",
    "tags: [a, b]",
    "status: beta",
    "agent:",
    "  owner: docs-team",
  );
  const result = parseAgentInstructions(yaml, F, { firstLine: 2 });
  assert.deepEqual(result.agent, { owner: "docs-team" });
  assert.deepEqual(result.diagnostics, []);
});
