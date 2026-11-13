import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import {
  createProof,
  formatProof,
  ProofError,
  proofSchema,
  PROOF_VERSION,
  writeProof,
  type ProofInput,
  type ProofExamples,
} from "../src/edits/proof.ts";

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(proofSchema);

/** SHA-256 of a text, as the record writes it. */
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "edits-proof-"));
}

/** The date every test uses unless it is testing dates. */
const DATE = "2026-01-01T00:00:00.000Z";

/** One edited file, with every optional field absent unless a test sets it. */
function input(overrides: Partial<ProofInput> = {}): ProofInput {
  return {
    siteRoot: "/site",
    files: ["docs/a.md"],
    before: { "docs/a.md": "old\n" },
    after: { "docs/a.md": "new\n" },
    ...overrides,
    date: overrides.date ?? DATE,
  };
}

/** The same edit with no date, so the test sees what SOURCE_DATE_EPOCH supplies. */
function undated(overrides: Partial<ProofInput> = {}): ProofInput {
  const { date: _date, ...rest } = input(overrides);
  return rest;
}

test("records the SHA-256 of the bytes before and after each file, sorted by path", () => {
  const record = createProof({
    siteRoot: "/site",
    files: ["docs/b.md", "docs/a.md"],
    before: { "docs/a.md": "old a\n", "docs/b.md": "old b\n" },
    after: { "docs/a.md": "new a\n", "docs/b.md": "new b\n" },
    date: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(record.version, PROOF_VERSION);
  assert.deepEqual(record.files, [
    { path: "docs/a.md", before: hash("old a\n"), after: hash("new a\n") },
    { path: "docs/b.md", before: hash("old b\n"), after: hash("new b\n") },
  ]);
  assert.equal("doctor" in record, false);
  assert.equal("examples" in record, false);
});

test("a file absent before is an added file and one absent after is a deleted file: the hash is null", () => {
  const record = createProof({
    siteRoot: "/site",
    files: ["docs/deleted.md", "docs/added.md"],
    before: { "docs/added.md": null, "docs/deleted.md": "gone\n" },
    after: { "docs/added.md": "new\n", "docs/deleted.md": null },
    date: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(record.files, [
    { path: "docs/added.md", before: null, after: hash("new\n") },
    { path: "docs/deleted.md", before: hash("gone\n"), after: null },
  ]);
});

test("keeps the doctor level and the findings it was given, in the doctor's order", () => {
  const findings = [
    { id: "ae.meta", severity: "warning" as const, message: "Missing description.", file: "docs/a.md", line: 2, column: 1 },
    { id: "ae.links", severity: "error" as const, message: "No page at /missing/." },
  ];
  const record = createProof(input({ doctor: { level: "L2", findings } }));

  assert.deepEqual(record.doctor, { level: "L2", findings });
  assert.deepEqual(createProof(input({ doctor: { level: null } })).doctor, { level: null });
  assert.deepEqual(
    createProof(input({ doctor: { level: "L3" } })).doctor,
    { level: "L3" },
    "findings stay out when the caller gives none",
  );
});

test("summarizes the examples an edit re-ran, sorted by code point and without duplicates", () => {
  const record = createProof(
    input({ examples: { rerun: ["browser/b", "node/a", "browser/b"], passed: 1, failed: 0, skipped: 1 } }),
  );

  assert.deepEqual(record.examples, { rerun: ["browser/b", "node/a"], passed: 1, failed: 0, skipped: 1 });
});

test("omitted skipped counts as zero and an explicit zero stays in the record", () => {
  const omitted = createProof(input({ examples: { rerun: ["node/a", "node/b"], passed: 1, failed: 1 } }));
  assert.deepEqual(omitted.examples, { rerun: ["node/a", "node/b"], passed: 1, failed: 1 });
  assert.equal("skipped" in omitted.examples!, false, "an omitted skipped is left out");

  const explicit = createProof(
    input({ examples: { rerun: ["node/a"], passed: 1, failed: 0, skipped: 0 } }),
  );
  assert.deepEqual(explicit.examples, { rerun: ["node/a"], passed: 1, failed: 0, skipped: 0 });
});

test("refuses a summary whose passed, failed, and skipped do not add up to the unique rerun list", () => {
  const cases = [
    { rerun: ["node/a"], passed: 1, failed: 1 },
    { rerun: ["node/a", "node/b"], passed: 1, failed: 0 },
    { rerun: [], passed: 1, failed: 0 },
    { rerun: ["node/a", "node/a"], passed: 2, failed: 0 },
    { rerun: ["node/a"], passed: 1, failed: 0, skipped: 1 },
  ];
  for (const examples of cases) {
    assert.throws(
      () => createProof(input({ examples })),
      (error: unknown) => error instanceof ProofError && error.code === "invalid-examples",
      JSON.stringify(examples),
    );
  }
});

test("refuses unsafe, fractional, negative, or unknown example counts", () => {
  const bad = [1.5, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", null];
  for (const value of bad) {
    for (const key of ["passed", "failed", "skipped"] as const) {
      const examples = {
        rerun: ["node/a"],
        passed: 0,
        failed: 0,
        [key]: value,
      } as unknown as ProofExamples;
      assert.throws(
        () => createProof(input({ examples })),
        (error: unknown) => error instanceof ProofError && error.code === "invalid-examples",
        `examples.${key} = ${String(value)}`,
      );
    }
  }
});

test("the same input gives the same bytes, whatever order the files came in", () => {
  const one = createProof(
    input({
      files: ["docs/a.md", "docs/b.md"],
      before: { "docs/a.md": "a\n", "docs/b.md": "b\n" },
      after: { "docs/a.md": "A\n", "docs/b.md": "B\n" },
    }),
  );
  const two = createProof(
    input({
      files: ["docs/b.md", "docs/a.md"],
      before: { "docs/b.md": "b\n", "docs/a.md": "a\n" },
      after: { "docs/b.md": "B\n", "docs/a.md": "A\n" },
    }),
  );

  const bytes = formatProof(one);
  assert.equal(formatProof(two), bytes);
  assert.equal(bytes.includes("\r"), false, "the record is LF only");
  assert.ok(bytes.endsWith("}\n"), "the record ends with one line feed");
  assert.ok(bytes.indexOf('"version"') < bytes.indexOf('"date"'));
  assert.ok(bytes.indexOf('"date"') < bytes.indexOf('"files"'));
  assert.equal(JSON.stringify(JSON.parse(bytes), null, 2) + "\n", bytes, "two spaces, no reordering");
});

test("records the resulting spans, sorted, with the SHA-256 of the text each covers", () => {
  const after = "# New\n\nBody\n";
  const record = createProof(
    input({
      after: { "docs/a.md": after },
      spans: {
        "docs/a.md": [
          { line: 3, column: 1, endLine: 3, endColumn: 4 },
          { line: 1, column: 3, endLine: 1, endColumn: 5 },
        ],
      },
    }),
  );

  assert.deepEqual(record.files[0]?.spans, [
    { line: 1, column: 3, endLine: 1, endColumn: 5, hash: hash("New") },
    { line: 3, column: 1, endLine: 3, endColumn: 4, hash: hash("Body") },
  ]);
  assert.equal("spans" in createProof(input()), false, "no spans are recorded when none are given");
});

test("refuses a resulting span that is outside the after text or has no text to hash", () => {
  assert.throws(
    () =>
      createProof(
        input({
          after: { "docs/a.md": "# New\n" },
          spans: { "docs/a.md": [{ line: 9, column: 1, endLine: 9, endColumn: 2 }] },
        }),
      ),
    (error: unknown) => error instanceof ProofError && error.code === "invalid-span",
  );
  assert.throws(
    () =>
      createProof(
        input({
          after: { "docs/a.md": null },
          spans: { "docs/a.md": [{ line: 1, column: 1, endLine: 1, endColumn: 1 }] },
        }),
      ),
    (error: unknown) => error instanceof ProofError && error.code === "invalid-span",
  );
});

test("the record validates against the schema embedded in the module", () => {
  const record = createProof(
    input({
      doctor: {
        level: "L1",
        findings: [{ id: "ae.meta", severity: "warning", message: "Missing description.", file: "docs/a.md", line: 1 }],
      },
      examples: { rerun: ["node/a"], passed: 1, failed: 0 },
      spans: { "docs/a.md": [{ line: 1, column: 1, endLine: 1, endColumn: 3 }] },
    }),
  );

  assert.equal(validate(JSON.parse(formatProof(record))), true, JSON.stringify(validate.errors));
});

test("the schema refuses a hash that is not SHA-256, an incomplete file entry, and an unknown key", () => {
  const record = JSON.parse(formatProof(createProof(input()))) as Record<string, unknown>;

  const badHash = structuredClone(record);
  (badHash.files as { before: string }[])[0]!.before = "ABC";
  assert.equal(validate(badHash), false);

  const incomplete = structuredClone(record);
  delete (incomplete.files as { after?: string }[])[0]!.after;
  assert.equal(validate(incomplete), false);

  const extra = structuredClone(record);
  extra.extra = true;
  assert.equal(validate(extra), false);
});

test("refuses a path that leaves the site root, a duplicate file, and a missing content side", () => {
  assert.throws(
    () => createProof(input({ files: ["../outside.md"] })),
    (error: unknown) => error instanceof ProofError && error.code === "invalid-path",
  );
  assert.throws(
    () => createProof(input({ files: ["docs/a.md", "docs/a.md"] })),
    (error: unknown) => error instanceof ProofError && error.code === "duplicate-path",
  );
  assert.throws(
    () => createProof(input({ before: {} })),
    (error: unknown) => error instanceof ProofError && error.code === "missing-content",
  );
});

test("keeps an absolute file inside the site root relative in the record", () => {
  const file = "/site/docs/a.md";
  const record = createProof({
    siteRoot: "/site",
    files: [file],
    before: { [file]: "old\n" },
    after: { [file]: "new\n" },
    date: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(record.files[0]?.path, "docs/a.md");
});

test("writes the record atomically, replacing an old one whole and leaving no temporary entry", async () => {
  const root = scratch();
  try {
    const out = ".mizzen/proof.json";
    const first = await writeProof({ ...input({ after: { "docs/a.md": "one\n" } }), siteRoot: root, out });
    assert.equal(readFileSync(join(root, out), "utf8"), formatProof(first));

    const second = await writeProof({ ...input({ after: { "docs/a.md": "two\n" } }), siteRoot: root, out });
    assert.equal(readFileSync(join(root, out), "utf8"), formatProof(second));
    assert.deepEqual(readdirSync(join(root, ".mizzen")), ["proof.json"], "no staging folder is left");
    assert.deepEqual(readdirSync(root), [".mizzen"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused record writes nothing and leaves an existing record untouched", async () => {
  const root = scratch();
  try {
    const out = join(root, ".mizzen", "proof.json");
    const first = await writeProof({ ...input(), siteRoot: root, out });
    const bytes = readFileSync(out, "utf8");

    await assert.rejects(
      writeProof({ ...input({ before: {} }), siteRoot: root, out }),
      (error: unknown) => error instanceof ProofError && error.code === "missing-content",
    );
    assert.equal(readFileSync(out, "utf8"), bytes);

    const missing = join(root, ".mizzen", "never.json");
    await assert.rejects(
      writeProof({ ...input({ files: ["../outside.md"] }), siteRoot: root, out: missing }),
      (error: unknown) => error instanceof ProofError && error.code === "invalid-path",
    );
    assert.deepEqual(readdirSync(join(root, ".mizzen")), ["proof.json"]);
    assert.equal(first.version, PROOF_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write with an inconsistent examples summary leaves an existing proof unchanged", async () => {
  const root = scratch();
  try {
    const out = join(root, ".mizzen", "proof.json");
    await writeProof({ ...input(), siteRoot: root, out });
    const bytes = readFileSync(out, "utf8");

    await assert.rejects(
      writeProof({
        ...input({ examples: { rerun: ["node/a"], passed: 1, failed: 1 } }),
        siteRoot: root,
        out,
      }),
      (error: unknown) => error instanceof ProofError && error.code === "invalid-examples",
    );
    assert.equal(readFileSync(out, "utf8"), bytes);
    assert.deepEqual(readdirSync(join(root, ".mizzen")), ["proof.json"], "no staging folder is left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a custom date wins, SOURCE_DATE_EPOCH dates the record, and without either there is no date", () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    assert.equal(
      createProof(input({ date: "2030-05-06T07:08:09.000Z" })).date,
      "2030-05-06T07:08:09.000Z",
      "an explicit date is not overridden",
    );
    assert.equal(createProof(undated()).date, "2026-01-01T00:00:00.000Z");

    delete process.env.SOURCE_DATE_EPOCH;
    assert.equal("date" in createProof(undated()), false, "no wall-clock timestamp");
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
});

test("refuses a malformed SOURCE_DATE_EPOCH instead of silently leaving the date out", () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = "not-a-number";
    assert.throws(
      () => createProof(undated()),
      (error: unknown) => error instanceof ProofError && error.code === "invalid-date",
    );
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
});
