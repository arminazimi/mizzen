import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { ContextRequest, ContextRequestProblem } from "../src/contracts/index.ts";
import { CONTEXT_REQUEST_VERSION, parseContextRequest } from "../src/packs/task.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schema/context-request.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

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

/** A request with only the fields the schema requires. */
function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, task: { goal: "Explain the install steps" }, budget: { maxTokens: 6000 }, ...extra };
}

test("the schema is closed, versioned, and draft 2020-12", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["version", "task", "budget"]);
  assert.equal(CONTEXT_REQUEST_VERSION, 1);
});

test("a full request round-trips through the schema unchanged", () => {
  const input = minimal({
    task: { goal: "  Explain how to install the engine  ", kind: "explain" },
    include: [" /guide/install/ ", "guide/setup.md"],
    exclude: ["/changelog/"],
    constraints: { locale: "en-US", version: { min: "v2", max: "v3.1" } },
    budget: { maxTokens: 6000, reservedTokens: 1200 },
    requiredEvidence: {
      refs: ["/guide/install/"],
      source: true,
      versions: true,
      warnings: false,
      dependencies: true,
    },
  });

  const request = parsed(input);
  assert.equal(request.task.goal, "Explain how to install the engine");
  assert.equal(request.constraints.locale, "en-us");

  assert.equal(validate(request), true, ajv.errorsText(validate.errors));
  const encoded = JSON.stringify(request);
  assert.deepEqual(JSON.parse(encoded), request);
  assert.equal(JSON.stringify(parsed(JSON.parse(encoded))), encoded);
  assert.deepEqual(Object.keys(request), [
    "version", "task", "include", "exclude", "constraints", "budget", "requiredEvidence",
  ]);
});

test("a minimal request gets the documented defaults and infers no task kind", () => {
  const request = parsed(minimal({ task: { goal: "Review the migration guide" } }));

  assert.deepEqual(request.include, []);
  assert.deepEqual(request.exclude, []);
  assert.deepEqual(request.constraints, {});
  assert.deepEqual(request.requiredEvidence, {
    refs: [],
    source: false,
    versions: false,
    warnings: false,
    dependencies: false,
  });
  assert.equal("kind" in request.task, false, "parsing never infers a kind from the goal");
  assert.equal(validate(request), true, ajv.errorsText(validate.errors));
});

test("invalid shapes produce a path and a specific reason", () => {
  const cases: Array<[string, unknown, string, RegExp]> = [
    ["a missing budget", { version: 1, task: { goal: "Install" } }, "/budget", /Missing required field `budget`/],
    ["a budget without maxTokens", minimal({ budget: {} }), "/budget/maxTokens", /Missing required field `maxTokens`/],
    ["a string budget", minimal({ budget: { maxTokens: "6000" } }), "/budget/maxTokens", /must be an integer; found a string/],
    ["a fractional budget", minimal({ budget: { maxTokens: 1.5 } }), "/budget/maxTokens", /must be an integer; found a number/],
    ["a zero budget", minimal({ budget: { maxTokens: 0 } }), "/budget/maxTokens", /must be at least 1/],
    ["an empty goal", minimal({ task: { goal: "   " } }), "/task/goal", /must be a non-empty sentence/],
    ["an unknown task key", minimal({ task: { goal: "Install", audience: "ops" } }), "/task/audience", /Unknown field `audience`. Use one of: `goal`, `kind`/],
    ["an unknown kind", minimal({ task: { goal: "Install", kind: "ship" } }), "/task/kind", /must be one of: `explain`/],
    ["an unsupported contract version", minimal({ version: 2 }), "/version", /Only context-request version 1/],
    ["an invalid version", minimal({ constraints: { version: { exact: "latest" } } }), "/constraints/version/exact", /version folder such as `v2`/],
    ["a four-part version", minimal({ constraints: { version: { min: "v1.2.3.4" } } }), "/constraints/version/min", /version folder such as `v2`/],
    ["an invalid locale", minimal({ constraints: { locale: "en_US" } }), "/constraints/locale", /BCP 47 language tag/],
    ["a one-letter locale", minimal({ constraints: { locale: "e" } }), "/constraints/locale", /BCP 47 language tag/],
    ["a duplicate include hint", minimal({ include: ["/guide/", "/guide/"] }), "/include/1", /repeats `\/guide\/`/],
    ["include not a list", minimal({ include: "/guide/" }), "/include", /must be an array; found a string/],
    ["a non-boolean evidence flag", minimal({ requiredEvidence: { source: "yes" } }), "/requiredEvidence/source", /must be a boolean/],
    ["the whole request a list", [], "", /The request must be an object; found an array/],
  ];

  for (const [name, value, path, message] of cases) {
    const [problem] = refused(value);
    assert.ok(problem, name);
    assert.equal(problem.path, path, name);
    assert.match(problem.message, message, name);
    assert.equal(validate(value), false, `${name}: the schema rejects what the parser rejects`);
  }
});

test("contradictory requests produce a specific error", () => {
  const cases: Array<[string, unknown, string, string, RegExp]> = [
    [
      "an included page is also excluded",
      minimal({ include: ["/guide/install/"], exclude: ["/guide/install/"] }),
      "/exclude/0",
      "context-request.include-excluded",
      /both included and excluded/,
    ],
    [
      "required evidence is excluded",
      minimal({ exclude: ["/guide/install/"], requiredEvidence: { refs: ["/guide/install/"] } }),
      "/requiredEvidence/refs/0",
      "context-request.evidence-excluded",
      /Required evidence `\/guide\/install\/` is also excluded/,
    ],
    [
      "an empty version range",
      minimal({ constraints: { version: {} } }),
      "/constraints/version",
      "context-request.version-empty",
      /needs `exact`, `min`, or `max`/,
    ],
    [
      "the same hint with different whitespace",
      minimal({ include: ["/guide/", " /guide/ "] }),
      "/include/1",
      "context-request.duplicate",
      /repeats `\/guide\/`/,
    ],
    [
      "reserved tokens leave nothing to spend",
      minimal({ budget: { maxTokens: 6000, reservedTokens: 6000 } }),
      "/budget/reservedTokens",
      "context-request.reserved-over-budget",
      /leaves nothing to spend/,
    ],
    [
      "exact with a range",
      minimal({ constraints: { version: { exact: "v2", min: "v1" } } }),
      "/constraints/version/exact",
      "context-request.version-conflict",
      /cannot be combined with `min` or `max`/,
    ],
    [
      "a backwards version range",
      minimal({ constraints: { version: { min: "v3", max: "v2.1" } } }),
      "/constraints/version/min",
      "context-request.version-order",
      /is newer than `max`/,
    ],
  ];

  for (const [name, value, path, code, message] of cases) {
    const [problem] = refused(value);
    assert.ok(problem, name);
    assert.equal(problem.path, path, name);
    assert.equal(problem.code, code, name);
    assert.match(problem.message, message, name);
  }
});

test("a version range compares numeric parts, not text", () => {
  const request = parsed(minimal({ constraints: { version: { min: "v9", max: "v10" } } }));
  assert.deepEqual(request.constraints.version, { min: "v9", max: "v10" });
  assert.deepEqual(
    parsed(minimal({ constraints: { version: { exact: "v2.1" } } })).constraints.version,
    { exact: "v2.1" },
  );

  const problems = refused(minimal({ constraints: { version: { min: "v10", max: "v9" } } }));
  assert.equal(problems[0]?.code, "context-request.version-order");
});

test("parsing is deterministic and needs no network or model", () => {
  const input = minimal({ include: [" /guide/ ", " /reference/ "], constraints: { locale: "FA" } });
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("parsing must not use the network");
  }) as typeof fetch;
  try {
    const first = parseContextRequest(input);
    const second = parseContextRequest(input);
    assert.deepEqual(first.problems, []);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.request?.constraints.locale, "fa");
  } finally {
    globalThis.fetch = original;
  }
});
