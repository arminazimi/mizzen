import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type {
  EditAuditPlan,
  EditAuditRecord,
  EditAuditVerification,
} from "../src/contracts/index.ts";
import {
  appendEditAudit,
  createEditAudit,
  EditAuditError,
  formatEditAudit,
  type EditAuditInput,
} from "../src/edits/audit.ts";
import {
  verifyEditAuditLedger,
  type EditAuditLedgerReport,
} from "../src/edits/audit-verify.ts";

/** The date every test uses, so nothing depends on the wall clock. */
const DATE = "2026-01-01T00:00:00.000Z";

/** Two fixed SHA-256 values; only their canonical form matters here. */
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);

/** The installed audit module, for the child processes that append concurrently. */
const AUDIT_URL = new URL("../src/edits/audit.ts", import.meta.url).href;

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "edits-audit-concurrency-"));
}

/** One plan, with every field the tests do not override. */
function plan(file = "docs/a.md", overrides: Partial<EditAuditPlan> = {}): EditAuditPlan {
  return {
    file,
    span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
    beforeHash: BEFORE,
    afterHash: AFTER,
    ...overrides,
  };
}

/** One applied, dated plan. */
function input(overrides: Partial<EditAuditInput> = {}): EditAuditInput {
  return { outcome: "applied", plan: plan(), date: DATE, ...overrides };
}

/** One verification whose failed check carries `message`. */
function failed(message: string): EditAuditVerification {
  return { status: "failed", checks: [{ id: "doctor.L1", status: "failed", message }] };
}

/** A record as it sits on disk, before the tests tamper with one field. */
function parsed(record: EditAuditRecord): Record<string, unknown> {
  return JSON.parse(formatEditAudit(record)) as Record<string, unknown>;
}

/** Writes one JSON value as one ledger line. */
function writeLedger(ledger: string, ...values: readonly unknown[]): void {
  writeFileSync(ledger, values.map((value) => `${JSON.stringify(value)}\n`).join(""), "utf8");
}

/** The issues as `line:code` pairs, so a test names the exact line and reason in one assert. */
function issues(report: EditAuditLedgerReport): string[] {
  return report.issues.map((issue) => `${issue.line}:${issue.code}`);
}

/**
 * Appends `jobs` in one child process, so several processes race for the same ledger. Each job is
 * `{ file, verification? }` and uses the fixed hashes above and the fixed date.
 */
function appendInChild(
  siteRoot: string,
  ledger: string,
  jobs: readonly { readonly file: string; readonly verification?: EditAuditVerification }[],
): Promise<void> {
  const script = `
(async () => {
  const { appendEditAudit } = await import(${JSON.stringify(AUDIT_URL)});
  const [siteRoot, ledger, encoded] = process.argv.slice(1);
  for (const job of JSON.parse(encoded)) {
    await appendEditAudit({
      siteRoot,
      ledger,
      outcome: "applied",
      plan: {
        file: job.file,
        span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
        beforeHash: ${JSON.stringify(BEFORE)},
        afterHash: ${JSON.stringify(AFTER)},
      },
      verification: job.verification,
      date: ${JSON.stringify(DATE)},
    });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, siteRoot, ledger, JSON.stringify(jobs)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with ${code}: ${stderr}`));
    });
  });
}

/**
 * A child process that drives the lock primitives on one request at a time, so two breakers can be
 * interleaved deterministically instead of racing on the scheduler.
 */
function lockChild(lock: string): { send(command: string): Promise<string>; close(): void } {
  const script = `
const { createInterface } = require("node:readline");
(async () => {
  const { auditLockInternals } = await import(${JSON.stringify(AUDIT_URL)});
  const lock = process.argv[1];
  let held;
  for await (const line of createInterface({ input: process.stdin })) {
    const space = line.indexOf(" ");
    const command = space === -1 ? line : line.slice(0, space);
    const argument = space === -1 ? undefined : line.slice(space + 1);
    try {
      if (command === "probe") console.log(JSON.stringify(await auditLockInternals.probeStaleLock(lock)));
      else if (command === "break") {
        console.log(JSON.stringify(await auditLockInternals.breakStaleLock(lock, JSON.parse(argument))));
      } else if (command === "acquire") {
        held = await auditLockInternals.acquireLedgerLock(lock, 2000);
        console.log(JSON.stringify(held.token));
      } else if (command === "release") {
        await auditLockInternals.releaseLedgerLock(held);
        console.log("null");
      } else if (command === "stop") break;
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  process.exit(0);
})();
`;

  const child = spawn(process.execPath, ["-e", script, lock], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next(line);
  });

  return {
    async send(command: string): Promise<string> {
      child.stdin.write(`${command}\n`);
      const line = lines.length > 0 ? lines.shift()! : await new Promise<string>((next) => waiting.push(next));
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && "error" in value) {
        throw new Error((value as { error: string }).error);
      }
      return line;
    },
    close(): void {
      child.kill();
    },
  };
}

/** The pid of a process that has already exited, like a writer interrupted while holding a lock. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  assert.ok(pid !== undefined);
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/, "the child is gone");
  return pid;
}

test("concurrent processes keep every distinct record exactly once, with no partial lines", async () => {
  const root = scratch();
  try {
    const ledger = ".mizzen/edit-audit.jsonl";
    const perChild = Array.from({ length: 6 }, (_, child) =>
      Array.from({ length: 4 }, (_, index) => ({ file: `docs/p${child}-${index}.md` })),
    );

    await Promise.all(perChild.map((jobs) => appendInChild(root, ledger, jobs)));

    const bytes = readFileSync(join(root, ledger), "utf8");
    assert.ok(bytes.endsWith("\n"), "the ledger ends with a line feed");
    const lines = bytes.slice(0, -1).split("\n");
    assert.equal(lines.length, 24, "every appended record is present");
    assert.equal(new Set(lines).size, 24, "no record was duplicated");
    for (const line of lines) JSON.parse(line);

    const report = await verifyEditAuditLedger(join(root, ledger));
    assert.deepEqual(report.issues, []);
    assert.equal(report.records, 24);
    assert.deepEqual(
      readdirSync(join(root, ".mizzen")),
      ["edit-audit.jsonl"],
      "no lock or staging folder is left behind",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent identical records stay idempotent", async () => {
  const root = scratch();
  try {
    const ledger = "ledger.jsonl";
    const jobs = [{ file: "docs/a.md" }];

    await Promise.all(Array.from({ length: 8 }, () => appendInChild(root, ledger, jobs)));

    const lines = readFileSync(join(root, ledger), "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, "eight processes appending one record wrote one line");
    assert.deepEqual((await verifyEditAuditLedger(join(root, ledger))).issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one plan with different verification evidence is two records, not a duplicate", async () => {
  const root = scratch();
  try {
    const ledger = "ledger.jsonl";

    await Promise.all([
      appendInChild(root, ledger, [{ file: "docs/a.md", verification: failed("first run") }]),
      appendInChild(root, ledger, [{ file: "docs/a.md", verification: failed("second run") }]),
    ]);

    const lines = readFileSync(join(root, ledger), "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 2, "different evidence is kept");
    const records = lines.map((line) => JSON.parse(line) as EditAuditRecord);
    assert.equal(records[0]!.id, records[1]!.id, "the plan identity is the same");
    assert.deepEqual(
      new Set(records.map((record) => record.verification.checks[0]!.message)),
      new Set(["first run", "second run"]),
      "neither verification was dropped",
    );
    assert.deepEqual(await verifyEditAuditLedger(join(root, ledger)), {
      ok: true,
      records: 2,
      issues: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock held by a live process refuses the append without touching the ledger", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    await appendEditAudit({ ...input(), siteRoot: root, ledger });
    const bytes = readFileSync(ledger, "utf8");
    writeFileSync(`${ledger}.lock`, `${process.pid} 1`, "utf8");

    await assert.rejects(
      appendEditAudit({
        ...input({ plan: plan("docs/b.md") }),
        siteRoot: root,
        ledger,
        lockTimeoutMs: 50,
      }),
      (error: unknown) => error instanceof EditAuditError && error.code === "ledger-locked",
    );

    assert.equal(readFileSync(ledger, "utf8"), bytes, "valid lines are not rewritten");
    assert.equal(existsSync(`${ledger}.lock`), true, "a lock this call does not own is left alone");
    rmSync(`${ledger}.lock`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an abandoned lock is recovered: by age, and when its process is gone", async () => {
  const root = scratch();
  try {
    const aged = join(root, "aged.jsonl");
    const dead = join(root, "dead.jsonl");
    await appendEditAudit({ ...input(), siteRoot: root, ledger: aged });
    await appendEditAudit({ ...input(), siteRoot: root, ledger: dead });

    writeFileSync(`${aged}.lock`, `${process.pid} 1`, "utf8");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(`${aged}.lock`, past, past);

    writeFileSync(`${dead}.lock`, `${await deadPid()} 1`, "utf8");

    const before = { aged: readFileSync(aged, "utf8"), dead: readFileSync(dead, "utf8") };
    await appendEditAudit({ ...input({ plan: plan("docs/b.md") }), siteRoot: root, ledger: aged });
    await appendEditAudit({ ...input({ plan: plan("docs/b.md") }), siteRoot: root, ledger: dead });

    for (const [name, ledger] of [
      ["aged", aged],
      ["dead", dead],
    ] as const) {
      const bytes = readFileSync(ledger, "utf8");
      assert.ok(bytes.startsWith(before[name]), `${name}: the valid existing lines are not rewritten`);
      assert.ok(bytes.endsWith("\n"));
      assert.equal(bytes.split("\n").filter((line) => line !== "").length, 2, `${name} gained the record`);
      assert.equal(existsSync(`${ledger}.lock`), false, `${name}: no live lock is left behind`);
      assert.deepEqual((await verifyEditAuditLedger(ledger)).issues, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two breakers that both saw a stale lock cannot remove the replacement one of them made", async () => {
  const root = scratch();
  try {
    const lock = join(root, "ledger.jsonl.lock");
    writeFileSync(lock, `${await deadPid()} 1`, "utf8");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(lock, past, past);

    const first = lockChild(lock);
    const second = lockChild(lock);
    try {
      // Both breakers inspect the old lock before either may remove it: the barrier is the parent
      // waiting for both probes to come back.
      const firstProbe = JSON.parse(await first.send("probe")) as { ino: number; stale: boolean };
      const secondProbe = JSON.parse(await second.send("probe")) as { ino: number; stale: boolean };
      assert.equal(firstProbe.stale, true);
      assert.equal(secondProbe.stale, true);
      assert.equal(firstProbe.ino, secondProbe.ino, "both saw the same stale inode");

      assert.equal(await first.send(`break ${JSON.stringify(firstProbe)}`), "true");
      const token = JSON.parse(await first.send("acquire")) as string;
      assert.equal(readFileSync(lock, "utf8"), token, "the first breaker's fresh lock is in place");

      assert.equal(
        await second.send(`break ${JSON.stringify(secondProbe)}`),
        "false",
        "the second breaker must not claim the stale lock after its replacement exists",
      );
      assert.equal(readFileSync(lock, "utf8"), token, "the second breaker left the fresh lock alone");
      assert.equal(existsSync(`${lock}.recover`), false, "no recovery guard is left behind");

      await first.send("release");
      assert.equal(existsSync(lock), false, "the first breaker released its own lock");
    } finally {
      first.close();
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refusal inside the lock removes the lock and leaves the damaged ledger as it was", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    mkdirSync(root, { recursive: true });
    writeFileSync(ledger, '{"version":1}', "utf8");

    await assert.rejects(
      appendEditAudit({ ...input(), siteRoot: root, ledger }),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-ledger",
    );

    assert.equal(readFileSync(ledger, "utf8"), '{"version":1}', "the damaged line is not rewritten or repaired");
    assert.equal(existsSync(`${ledger}.lock`), false, "the lock is removed on refusal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier accepts a canonical ledger and counts its records", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    writeFileSync(
      ledger,
      formatEditAudit(createEditAudit(input())) +
        formatEditAudit(createEditAudit(input({ plan: plan("docs/b.md"), verification: failed("missing description") }))),
      "utf8",
    );

    const report = await verifyEditAuditLedger(ledger);
    assert.deepEqual(report, { ok: true, records: 2, issues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier reports the exact line for a truncated ledger and a missing final line feed", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "truncated.jsonl");
    writeFileSync(ledger, `${formatEditAudit(createEditAudit(input()))}{"version":1`, "utf8");

    assert.deepEqual(issues(await verifyEditAuditLedger(ledger)), ["2:truncated-line"]);

    const complete = join(root, "complete.jsonl");
    writeFileSync(complete, formatEditAudit(createEditAudit(input())).slice(0, -1), "utf8");
    assert.deepEqual(issues(await verifyEditAuditLedger(complete)), ["1:truncated-line"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier reports malformed JSON and empty lines at their lines", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    const line = formatEditAudit(createEditAudit(input()));
    const other = formatEditAudit(createEditAudit(input({ plan: plan("docs/b.md") })));
    writeFileSync(ledger, `${line}{oops}\n\n${other}`, "utf8");

    const report = await verifyEditAuditLedger(ledger);
    assert.deepEqual(issues(report), ["2:malformed-json", "3:empty-line"]);
    assert.equal(report.records, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier refuses a non-canonical id, path, hash, date, or shape", async () => {
  const root = scratch();
  try {
    const record = parsed(createEditAudit(input()));
    const cases: readonly [string, (value: Record<string, unknown>) => void, string][] = [
      ["invalid-id", (value) => (value.id = "0".repeat(64)), "1:invalid-id"],
      [
        "invalid-path",
        (value) => ((value.plan as { file: string }).file = "../outside.md"),
        "1:invalid-path",
      ],
      [
        "invalid-hash",
        (value) => ((value.plan as { beforeHash: string }).beforeHash = BEFORE.toUpperCase()),
        "1:invalid-hash",
      ],
      [
        "invalid-hash",
        (value) => ((value.plan as { afterHash: unknown }).afterHash = null),
        "1:invalid-hash",
      ],
      ["invalid-date", (value) => (value.date = "yesterday"), "1:invalid-record"],
      ["invalid-record", (value) => (value.extra = true), "1:invalid-record"],
    ];

    for (const [name, tamper, expected] of cases) {
      const tampered = structuredClone(record);
      tamper(tampered);
      const ledger = join(root, `${name}-${expected.replace(":", "-")}.jsonl`);
      writeLedger(ledger, tampered);
      const found = issues(await verifyEditAuditLedger(ledger));
      assert.ok(found.includes(expected), `${name}: ${found.join(",")} must include ${expected}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier refuses inconsistent and unsorted checks", async () => {
  const root = scratch();
  try {
    const passed = parsed(
      createEditAudit(
        input({ verification: { status: "passed", checks: [{ id: "doctor.L1", status: "passed" }] } }),
      ),
    );
    (passed.verification as { checks: { status: string }[] }).checks[0]!.status = "failed";
    writeLedger(join(root, "status.jsonl"), passed);
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "status.jsonl"))), ["1:invalid-check"]);

    const duplicate = parsed(
      createEditAudit(
        input({
          verification: {
            status: "passed",
            checks: [
              { id: "doctor.L1", status: "passed" },
              { id: "doctor.L2", status: "passed" },
            ],
          },
        }),
      ),
    );
    (duplicate.verification as { checks: unknown[] }).checks = [
      { id: "doctor.L1", status: "passed" },
      { id: "doctor.L1", status: "passed" },
    ];
    writeLedger(join(root, "duplicate.jsonl"), duplicate);
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "duplicate.jsonl"))), ["1:invalid-check"]);

    const unsorted = parsed(
      createEditAudit(
        input({
          verification: {
            status: "passed",
            checks: [
              { id: "doctor.L1", status: "passed" },
              { id: "doctor.L2", status: "passed" },
            ],
          },
        }),
      ),
    );
    (unsorted.verification as { checks: unknown[] }).checks = [
      { id: "doctor.L2", status: "passed" },
      { id: "doctor.L1", status: "passed" },
    ];
    writeLedger(join(root, "unsorted.jsonl"), unsorted);
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "unsorted.jsonl"))), ["1:invalid-check"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier reports unredacted credentials and machine paths", async () => {
  const root = scratch();
  try {
    const credential = parsed(createEditAudit(input({ verification: failed("clean") })));
    (credential.verification as { checks: { message: string }[] }).checks[0]!.message =
      "token=abc123 refused";
    writeLedger(join(root, "credential.jsonl"), credential);
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "credential.jsonl"))), [
      "1:unredacted-credential",
    ]);

    const path = parsed(createEditAudit(input({ verification: failed("clean") })));
    (path.verification as { checks: { message: string }[] }).checks[0]!.message =
      "read /Users/armin/site/docs/a.md";
    writeLedger(join(root, "path.jsonl"), path);
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "path.jsonl"))), ["1:unredacted-path"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier reports an exact duplicate, but two verification runs of one plan are fine", async () => {
  const root = scratch();
  try {
    const first = formatEditAudit(createEditAudit(input()));
    const second = formatEditAudit(
      createEditAudit(input({ verification: failed("a later run") })),
    );

    writeFileSync(join(root, "duplicated.jsonl"), first + first, "utf8");
    assert.deepEqual(issues(await verifyEditAuditLedger(join(root, "duplicated.jsonl"))), [
      "2:duplicate-record",
    ]);

    writeFileSync(join(root, "evidence.jsonl"), first + second, "utf8");
    assert.deepEqual(await verifyEditAuditLedger(join(root, "evidence.jsonl")), {
      ok: true,
      records: 2,
      issues: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty ledger is valid, and a missing one is refused", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "empty.jsonl");
    writeFileSync(ledger, "", "utf8");
    assert.deepEqual(await verifyEditAuditLedger(ledger), { ok: true, records: 0, issues: [] });

    await assert.rejects(
      verifyEditAuditLedger(join(root, "missing.jsonl")),
      (error: unknown) => error instanceof EditAuditError && error.code === "invalid-ledger",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
