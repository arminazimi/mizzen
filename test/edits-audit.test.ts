import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  EditAuditCheck,
  EditAuditPlan,
  EditAuditRecord,
  EditAuditVerification,
} from "../src/contracts/index.ts";
import {
  appendEditAudit,
  createEditAudit,
  EDIT_AUDIT_VERSION,
  EditAuditError,
  formatEditAudit,
  redactAuditText,
  type EditAuditInput,
} from "../src/edits/audit.ts";
import { editApply } from "../src/cli/edit-apply.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schema/edit-audit.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** SHA-256 of a text, as the ledger writes it. */
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "edits-audit-"));
}

/** The date every test uses unless it is testing dates. */
const DATE = "2026-01-01T00:00:00.000Z";

/** One plan, with every field the tests do not override. */
function plan(overrides: Partial<EditAuditPlan> = {}): EditAuditPlan {
  return {
    file: "docs/a.md",
    span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
    beforeHash: hash("# Old\n"),
    afterHash: hash("# New\n"),
    ...overrides,
  };
}

/** One applied plan, dated so the tests are deterministic. */
function input(overrides: Partial<EditAuditInput> = {}): EditAuditInput {
  return { outcome: "applied", plan: plan(), date: DATE, ...overrides };
}

/** The same input with no explicit date, so the test sees what SOURCE_DATE_EPOCH supplies. */
function undated(overrides: Partial<EditAuditInput> = {}): EditAuditInput {
  const { date: _date, ...rest } = input(overrides);
  return rest;
}

/** A verification whose checks were given in whatever order. */
function verification(
  status: EditAuditVerification["status"],
  checks: readonly EditAuditCheck[],
): EditAuditVerification {
  return { status, checks };
}

test("records one applied plan with its span, source hashes, and outcome", () => {
  const record = createEditAudit(input());

  assert.equal(record.version, EDIT_AUDIT_VERSION);
  assert.match(record.id, /^[0-9a-f]{64}$/);
  assert.equal(record.outcome, "applied");
  assert.deepEqual(record.plan, plan());
  assert.deepEqual(record.verification, { status: "skipped", checks: [] });
  assert.equal(record.date, DATE);
  assert.deepEqual(createEditAudit(input()), record, "the same plan gives the same record");
});

test("correlates the same plan with the same id and a different one with a different id", () => {
  const applied = createEditAudit(input());
  const same = createEditAudit(input({ plan: plan({ beforeHash: hash("# Old\n").toUpperCase() }) }));
  assert.equal(same.id, applied.id, "a hash's case does not change the plan");
  assert.notEqual(
    createEditAudit(input({ plan: plan({ span: { line: 1, column: 1, endLine: 1, endColumn: 6 } }) })).id,
    applied.id,
    "a different span is a different plan",
  );
  assert.notEqual(
    createEditAudit(input({ plan: plan({ file: "docs/b.md" }) })).id,
    createEditAudit(input()).id,
  );
  assert.notEqual(
    createEditAudit(input({ outcome: "rejected", plan: plan({ afterHash: null }) })).id,
    createEditAudit(input({ outcome: "rejected", plan: plan({ afterHash: null, file: "docs/b.md" }) })).id,
  );
});

test("keeps verification results sorted by check id, with their file and line", () => {
  const record = createEditAudit(
    input({
      verification: verification("failed", [
        { id: "doctor.L2", status: "passed", message: "Level 2 reached." },
        { id: "doctor.L1", status: "failed", message: "Missing description.", file: "docs/a.md", line: 2 },
      ]),
    }),
  );

  assert.deepEqual(record.verification, {
    status: "failed",
    checks: [
      { id: "doctor.L1", status: "failed", message: "Missing description.", file: "docs/a.md", line: 2 },
      { id: "doctor.L2", status: "passed", message: "Level 2 reached." },
    ],
  });
});

test("redacts credentials, environment values, and machine-local paths deterministically", () => {
  const message =
    "read /Users/armin/site/docs/a.md with token=abc123 and Authorization: Bearer eyJhbGciOi.J9 " +
    "while AWS_SECRET_ACCESS_KEY=supersecret, ghp_abcdefghijklmnopqrstuvwxyz0123456789, and ~/notes.md";
  const once = redactAuditText(message);
  const twice = redactAuditText(message);

  assert.equal(once, twice, "redaction is deterministic");
  for (const secret of ["abc123", "eyJhbGciOi", "supersecret", "ghp_abcdef", "/Users/armin", "~/notes.md"]) {
    assert.equal(once.includes(secret), false, `${secret} must not survive redaction`);
  }
  assert.ok(once.includes("<redacted>"));
  assert.ok(once.includes("<path>"));

  const record = createEditAudit(
    input({ verification: verification("failed", [{ id: "doctor.L1", status: "failed", message }]) }),
  );
  assert.equal(formatEditAudit(record).includes("supersecret"), false);
});

test("records a rejected plan as rejected, with no after hash and no verification", () => {
  const record = createEditAudit(input({ outcome: "rejected", plan: plan({ afterHash: null }) }));

  assert.equal(record.outcome, "rejected");
  assert.equal(record.plan.afterHash, null);
  assert.deepEqual(record.verification, { status: "skipped", checks: [] });
});

test("refuses a success record for a plan that did not complete, and a rejection that claims verification", () => {
  assert.throws(
    () => createEditAudit(input({ plan: plan({ afterHash: null }) })),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
  );
  assert.throws(
    () => createEditAudit(input({ outcome: "rejected", plan: plan({ afterHash: hash("# New\n") }) })),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
  );
  assert.throws(
    () =>
      createEditAudit(
        input({
          outcome: "rejected",
          plan: plan({ afterHash: null }),
          verification: verification("passed", [{ id: "doctor.L1", status: "passed" }]),
        }),
      ),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
  );
  assert.throws(
    () =>
      createEditAudit(
        input({
          outcome: "rejected",
          plan: plan({ afterHash: null }),
          verification: verification("skipped", [{ id: "doctor.L1", status: "passed" }]),
        }),
      ),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
  );
});

test("refuses a verification that claims more than its checks support", () => {
  const cases: readonly EditAuditVerification[] = [
    verification("passed", [{ id: "doctor.L1", status: "failed" }]),
    verification("failed", [{ id: "doctor.L1", status: "passed" }]),
    verification("passed", []),
    verification("failed", []),
    verification("skipped", [{ id: "doctor.L1", status: "passed" }]),
    verification("passed", [
      { id: "doctor.L1", status: "passed" },
      { id: "doctor.L1", status: "passed" },
    ]),
  ];
  for (const value of cases) {
    assert.throws(
      () => createEditAudit(input({ verification: value })),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
      JSON.stringify(value),
    );
  }

  assert.throws(
    () => createEditAudit(input({ verification: verification("passed", [{ id: "not a check", status: "passed" }]) })),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
  );
  assert.throws(
    () =>
      createEditAudit(
        input({ verification: verification("failed", [{ id: "doctor.L1", status: "failed", message: "one\ntwo" }]) }),
      ),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
  );
  assert.throws(
    () =>
      createEditAudit(
        input({
          verification: verification("failed", [
            { id: "doctor.L1", status: "failed", file: "/Users/armin/site/docs/a.md" },
          ]),
        }),
      ),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-verification",
  );
});

test("refuses a path that leaves the site root and a span that is not usable", () => {
  for (const file of ["../outside.md", "/site/docs/a.md", "C:\\docs\\a.md", "docs\\a.md", "."]) {
    assert.throws(
      () => createEditAudit(input({ plan: plan({ file }) })),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
      file,
    );
  }
  assert.throws(
    () => createEditAudit(input({ plan: plan({ span: { line: 2, column: 1, endLine: 1, endColumn: 3 } }) })),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
  );
  assert.throws(
    () => createEditAudit(input({ plan: plan({ beforeHash: "ABC" }) })),
    (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
  );
});

test("formats one compact line with a fixed key order", () => {
  const text = formatEditAudit(createEditAudit(input()));

  assert.equal(text.split("\n").length, 2, "one line plus its final line feed");
  assert.ok(text.endsWith("}\n"));
  assert.equal(text.includes("\r"), false);
  assert.ok(text.indexOf('"version"') < text.indexOf('"id"'));
  assert.ok(text.indexOf('"id"') < text.indexOf('"outcome"'));
  assert.ok(text.indexOf('"outcome"') < text.indexOf('"plan"'));
  assert.ok(text.indexOf('"plan"') < text.indexOf('"verification"'));
  assert.ok(text.indexOf('"verification"') < text.indexOf('"date"'));
  assert.deepEqual(JSON.parse(text), createEditAudit(input()));
});

test("appends one line per plan and leaves the ledger's earlier bytes untouched", async () => {
  const root = scratch();
  try {
    const ledger = ".mizzen/edit-audit.jsonl";
    const first = await appendEditAudit({ ...input(), siteRoot: root, ledger });
    const second = await appendEditAudit({
      ...input({ plan: plan({ file: "docs/b.md" }) }),
      siteRoot: root,
      ledger,
    });

    const bytes = readFileSync(join(root, ledger), "utf8");
    assert.equal(bytes, formatEditAudit(first) + formatEditAudit(second));
    assert.deepEqual(readdirSync(join(root, ".mizzen")), ["edit-audit.jsonl"], "no staging folder is left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replaying the same plan appends nothing and writes the same bytes as a fresh ledger", async () => {
  const root = scratch();
  const other = scratch();
  try {
    await appendEditAudit({ ...input(), siteRoot: root, ledger: "ledger.jsonl" });
    const bytes = readFileSync(join(root, "ledger.jsonl"), "utf8");
    await appendEditAudit({ ...input(), siteRoot: root, ledger: "ledger.jsonl" });
    assert.equal(readFileSync(join(root, "ledger.jsonl"), "utf8"), bytes, "the record is not duplicated");

    await appendEditAudit({ ...input(), siteRoot: other, ledger: "ledger.jsonl" });
    assert.equal(readFileSync(join(other, "ledger.jsonl"), "utf8"), bytes, "equivalent input gives equivalent bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a refused record writes nothing and leaves the ledger byte-identical", async () => {
  const root = scratch();
  try {
    const ledger = ".mizzen/edit-audit.jsonl";
    await appendEditAudit({ ...input(), siteRoot: root, ledger });
    const bytes = readFileSync(join(root, ledger), "utf8");

    await assert.rejects(
      appendEditAudit({ ...input({ plan: plan({ afterHash: null }) }), siteRoot: root, ledger }),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
    );
    assert.equal(readFileSync(join(root, ledger), "utf8"), bytes);

    await assert.rejects(
      appendEditAudit({ ...input({ plan: plan({ file: "../outside.md" }) }), siteRoot: root, ledger: ".mizzen/never.jsonl" }),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-plan",
    );
    assert.equal(existsSync(join(root, ".mizzen", "never.jsonl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to append to a damaged ledger without repairing it", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    mkdirSync(root, { recursive: true });
    writeFileSync(ledger, '{"version":1}', "utf8");

    await assert.rejects(
      appendEditAudit({ ...input(), siteRoot: root, ledger }),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-ledger",
    );
    assert.equal(readFileSync(ledger, "utf8"), '{"version":1}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the schema validates the written record and refuses an incomplete or unknown-key record", () => {
  const record = createEditAudit(
    input({
      verification: verification("failed", [
        { id: "doctor.L1", status: "failed", message: "Missing description.", file: "docs/a.md", line: 1 },
      ]),
    }),
  );
  const written = JSON.parse(formatEditAudit(record)) as Record<string, unknown>;
  assert.equal(validate(written), true, JSON.stringify(validate.errors));

  const incomplete = structuredClone(written);
  delete (incomplete.plan as { afterHash?: string }).afterHash;
  assert.equal(validate(incomplete), false);

  const extra = structuredClone(written);
  extra.extra = true;
  assert.equal(validate(extra), false);

  const uppercase = structuredClone(written);
  (uppercase.plan as { beforeHash: string }).beforeHash = "ABC";
  assert.equal(validate(uppercase), false);

  const badCheck = structuredClone(written);
  (badCheck.verification as { checks: { id: string }[] }).checks[0]!.id = "not a check";
  assert.equal(validate(badCheck), false);
});

test("a custom date wins, SOURCE_DATE_EPOCH dates the record, and without either there is no date", () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    assert.equal(
      createEditAudit(input({ date: "2030-05-06T07:08:09.000Z" })).date,
      "2030-05-06T07:08:09.000Z",
      "an explicit date is not overridden",
    );
    assert.equal(createEditAudit(undated()).date, "2026-01-01T00:00:00.000Z");

    delete process.env.SOURCE_DATE_EPOCH;
    assert.equal("date" in createEditAudit(undated()), false, "no wall-clock timestamp");

    process.env.SOURCE_DATE_EPOCH = "not-a-number";
    assert.throws(
      () => createEditAudit(undated()),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-date",
    );
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
});

test("edit apply appends one correlated record for the plan it wrote", async () => {
  const root = scratch();
  try {
    const source = "# Old\n";
    const patchPath = join(root, "patch.json");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), source, "utf8");
    writeFileSync(
      patchPath,
      JSON.stringify({
        span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
        expected: "# Old",
        replacement: "# New",
        beforeHash: hash(source),
      }),
      "utf8",
    );

    const result = await editApply({ siteRoot: root, patch: patchPath });
    const lines = readFileSync(`${resolve(patchPath)}.audit.jsonl`, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1, "one record per applied plan");
    const record = JSON.parse(lines[0]!) as EditAuditRecord;

    assert.equal(result.dryRun, false);
    assert.equal(record.outcome, "applied");
    assert.equal(record.plan.file, "docs/a.md");
    assert.deepEqual(record.plan.span, { line: 1, column: 1, endLine: 1, endColumn: 5 });
    assert.equal(record.plan.beforeHash, hash(source));
    assert.equal(record.plan.afterHash, hash("# New\n"));
    assert.deepEqual(record.verification, { status: "skipped", checks: [] });
    assert.equal(validate(JSON.parse(lines[0]!)), true, JSON.stringify(validate.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit apply's dry run and refused patch write no ledger record", async () => {
  const root = scratch();
  try {
    const source = "# Old\n";
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), source, "utf8");

    const stale = join(root, "stale.json");
    writeFileSync(
      stale,
      JSON.stringify({
        span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
        expected: "# Different",
        replacement: "# New",
      }),
      "utf8",
    );
    await assert.rejects(editApply({ siteRoot: root, patch: stale }), /refused/);
    assert.equal(existsSync(`${resolve(stale)}.audit.jsonl`), false);

    const dry = join(root, "dry.json");
    writeFileSync(
      dry,
      JSON.stringify({
        span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
        expected: "# Old",
        replacement: "# New",
      }),
      "utf8",
    );
    await editApply({ siteRoot: root, patch: dry, dryRun: true });
    assert.equal(existsSync(`${resolve(dry)}.audit.jsonl`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
