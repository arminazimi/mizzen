import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextRequest, ContextRequestProblem } from "../src/contracts/index.ts";
import { parseContextRequest } from "../src/packs/task.ts";

/** Parses a request that must be valid, and returns it. */
function parsed(value: unknown): ContextRequest {
  const result = parseContextRequest(value);
  assert.deepEqual(result.problems, []);
  assert.ok(result.request, "a valid request has a request");
  return result.request;
}

/** Parses a request that must be refused, and returns its problems. */
function refused(value: unknown): readonly ContextRequestProblem[] {
  const result = parseContextRequest(value);
  assert.equal(result.request, undefined);
  assert.ok(result.problems.length > 0, "a refused request has problems");
  return result.problems;
}

/** A request with only the fields the schema requires, plus a version range. */
function range(min: string, max: string): Record<string, unknown> {
  return {
    version: 1,
    task: { goal: "Explain the install steps" },
    constraints: { version: { min, max } },
    budget: { maxTokens: 6000 },
  };
}

test("huge version bounds are ordered exactly, without becoming Infinity", () => {
  const huge = "9".repeat(400);
  const smaller = "8".repeat(400);

  assert.deepEqual(parsed(range(`v${smaller}`, `v${huge}`)).constraints.version, {
    min: `v${smaller}`,
    max: `v${huge}`,
  });

  const [problem] = refused(range(`v${huge}`, `v${smaller}`));
  assert.ok(problem);
  assert.equal(problem.path, "/constraints/version/min");
  assert.equal(problem.code, "context-request.version-order");
  assert.match(problem.message, new RegExp(`\`min\` \\(v${huge}\\) is newer than \`max\` \\(v${smaller}\\)`));
});

test("bounds beyond the safe integer range keep their last digit significant", () => {
  // 2^53 and 2^53 + 1 both round to the same Number.
  assert.deepEqual(parsed(range("v9007199254740992", "v9007199254740993")).constraints.version, {
    min: "v9007199254740992",
    max: "v9007199254740993",
  });

  const [problem] = refused(range("v9007199254740993", "v9007199254740992"));
  assert.ok(problem);
  assert.equal(problem.path, "/constraints/version/min");
  assert.equal(problem.code, "context-request.version-order");
});

test("leading zeros compare by value, not by digit count", () => {
  assert.deepEqual(parsed(range("v009", "v00010")).constraints.version, { min: "v009", max: "v00010" });

  const [problem] = refused(range("v00010", "v009"));
  assert.ok(problem);
  assert.equal(problem.path, "/constraints/version/min");
  assert.equal(problem.code, "context-request.version-order");
});

test("omitted minor and patch components count as zero", () => {
  for (const [min, max] of [
    ["v2", "v2.0.0"],
    ["v2.0", "v2.0.0"],
    ["v02.0.0", "v2"],
    ["v2.0.1", "v2.1"],
  ]) {
    assert.deepEqual(parsed(range(min ?? "", max ?? "")).constraints.version, { min, max });
  }

  for (const [min, max] of [
    ["v2.0.1", "v2"],
    ["v2", "v1.999999999999999999999"],
  ]) {
    const [problem] = refused(range(min ?? "", max ?? ""));
    assert.ok(problem);
    assert.equal(problem.path, "/constraints/version/min");
    assert.equal(problem.code, "context-request.version-order");
  }
});

test("diagnostics for a reversed huge range are deterministic", () => {
  const min = `v${"9".repeat(400)}`;
  const max = `v${"9".repeat(399)}8`;
  const first = parseContextRequest(range(min, max));
  const second = parseContextRequest(range(min, max));
  assert.deepEqual(first.problems, second.problems);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.problems[0]?.message, `\`min\` (${min}) is newer than \`max\` (${max}); swap them or widen the range.`);
});
