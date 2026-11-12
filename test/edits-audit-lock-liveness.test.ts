/**
 * Lock liveness for the audit ledger (#99, M2.11).
 *
 * These tests pin the rule that age alone must never make a live writer's lock stealable: a lock
 * whose recorded process is running stays unbroken no matter how old its mtime is, while a lock
 * whose process is gone, an unowned token, and an abandoned recovery guard remain recoverable.
 * The "owner" is a real child process spawned by the test, so liveness is deterministic rather
 * than a wall-clock race.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { EditAuditPlan } from "../src/contracts/index.ts";
import {
  appendEditAudit,
  auditLockInternals,
  createEditAudit,
  EditAuditError,
  formatEditAudit,
  type EditAuditInput,
  type StaleLockProbe,
} from "../src/edits/audit.ts";
import { verifyEditAuditLedger } from "../src/edits/audit-verify.ts";

/** The date every test uses, so nothing depends on the wall clock. */
const DATE = "2026-01-01T00:00:00.000Z";

/** Two fixed SHA-256 values; only their canonical form matters here. */
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);

/** The installed audit module, for the child processes that hold locks. */
const AUDIT_URL = new URL("../src/edits/audit.ts", import.meta.url).href;

/** One hour ago: far past the stale-age threshold, on any clock. */
function oneHourAgo(): Date {
  return new Date(Date.now() - 3_600_000);
}

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "edits-audit-lock-liveness-"));
}

/** One plan, with every field the tests do not override. */
function plan(file = "docs/a.md"): EditAuditPlan {
  return {
    file,
    span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
    beforeHash: BEFORE,
    afterHash: AFTER,
  };
}

/** One applied, dated plan. */
function input(overrides: Partial<EditAuditInput> = {}): EditAuditInput {
  return { outcome: "applied", plan: plan(), date: DATE, ...overrides };
}

/** The ledger's lines, refusing a partial one: every line parses and the file ends with a feed. */
function completeLines(ledger: string): string[] {
  const bytes = readFileSync(ledger, "utf8");
  assert.ok(bytes.endsWith("\n"), "the ledger ends with a line feed, so no record is half-written");
  const lines = bytes.slice(0, -1).split("\n");
  for (const line of lines) JSON.parse(line);
  return lines;
}

/**
 * A child process that drives the lock primitives on the parent's command, so the live owner of a
 * lock is a real running process taken over by {@link auditLockInternals} itself.
 */
function lockChild(lock: string): {
  send(command: string): Promise<string>;
  kill(): Promise<void>;
} {
  const script = `
const { createInterface } = require("node:readline");
(async () => {
  const { auditLockInternals } = await import(${JSON.stringify(AUDIT_URL)});
  const lock = process.argv[1];
  let held;
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      if (line === "acquire") {
        held = await auditLockInternals.acquireLedgerLock(lock, 5000);
        console.log(JSON.stringify(held.token));
      } else if (line === "release") {
        await auditLockInternals.releaseLedgerLock(held);
        console.log("null");
      } else if (line === "stop") break;
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
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
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
    async kill(): Promise<void> {
      child.kill("SIGKILL");
      await exited;
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

test("an aged lock whose owner is alive is never stolen, and the competing append times out intact", async () => {
  const root = scratch();
  const ledger = join(root, "ledger.jsonl");
  const lock = `${ledger}.lock`;
  try {
    await appendEditAudit({ ...input(), siteRoot: root, ledger });
    const bytes = readFileSync(ledger, "utf8");

    const holder = lockChild(lock);
    try {
      const token = JSON.parse(await holder.send("acquire")) as string;
      const past = oneHourAgo();
      utimesSync(lock, past, past);

      // The probe reports the truth: the owner is a running process, so the lock is not stale.
      const probe = await auditLockInternals.probeStaleLock(lock);
      assert.ok(probe !== undefined, "the lock exists");
      assert.equal(probe.stale, false, "age alone does not make a live writer's lock stale");
      assert.equal(probe.token, token, "the probe kept the live writer's token");

      // Breaking cannot be talked into stealing, even with a forged probe that claims staleness.
      assert.equal(await auditLockInternals.breakStaleLock(lock), false);
      const forged: StaleLockProbe = { token: probe.token, ino: probe.ino, stale: true };
      assert.equal(await auditLockInternals.breakStaleLock(lock, forged), false);
      assert.equal(readFileSync(lock, "utf8"), token, "the live writer's lock is still in place");

      // The competing append waits its bounded time and refuses; it never renames over the holder.
      await assert.rejects(
        appendEditAudit({
          ...input({ plan: plan("docs/b.md") }),
          siteRoot: root,
          ledger,
          lockTimeoutMs: 100,
        }),
        (error: unknown) => error instanceof EditAuditError && error.code === "ledger-locked",
      );
      assert.equal(readFileSync(ledger, "utf8"), bytes, "the refused append wrote nothing, not even a partial line");
      assert.equal(readFileSync(lock, "utf8"), token, "the timed-out append left the live lock alone");
    } finally {
      await holder.kill();
    }

    // The owner is gone now: the same aged lock is recovered and the append lands exactly once.
    await appendEditAudit({
      ...input({ plan: plan("docs/b.md") }),
      siteRoot: root,
      ledger,
      lockTimeoutMs: 5_000,
    });
    assert.equal(
      readFileSync(ledger, "utf8"),
      bytes + formatEditAudit(createEditAudit(input({ plan: plan("docs/b.md") }))),
      "the recovered append added one whole line after the untouched ones",
    );
    assert.equal(existsSync(lock), false, "the recovered lock is gone after the append");
    assert.equal(existsSync(`${lock}.recover`), false, "no recovery guard is left behind");
    assert.deepEqual((await verifyEditAuditLedger(ledger)).issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead lock owner is recovered even before the stale age, and replays stay duplicate-free", async () => {
  const root = scratch();
  const ledger = join(root, "ledger.jsonl");
  const lock = `${ledger}.lock`;
  try {
    writeFileSync(lock, `${await deadPid()} 1`, "utf8");

    const probe = await auditLockInternals.probeStaleLock(lock);
    assert.ok(probe !== undefined);
    assert.equal(probe.stale, true, "a lock whose process is gone is stale at any age");

    await appendEditAudit({ ...input(), siteRoot: root, ledger, lockTimeoutMs: 5_000 });
    assert.equal(completeLines(ledger).length, 1, "the first append after recovery wrote one record");
    assert.equal(existsSync(lock), false, "the writer took its own lock and released it");

    await appendEditAudit({ ...input(), siteRoot: root, ledger });
    assert.equal(completeLines(ledger).length, 1, "replaying the same plan added no duplicate");
    assert.deepEqual((await verifyEditAuditLedger(ledger)).issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aged lock no live process owns stays recoverable, whatever its token looks like", async () => {
  const root = scratch();
  try {
    const unowned = ["", "not-a-pid 7", `${process.pid} 9`];
    for (const [index, token] of unowned.entries()) {
      const ledger = join(root, `unowned-${index}.jsonl`);
      const lock = `${ledger}.lock`;
      writeFileSync(lock, token, "utf8");
      const past = oneHourAgo();
      utimesSync(lock, past, past);

      const probe = await auditLockInternals.probeStaleLock(lock);
      assert.ok(probe !== undefined);
      assert.equal(probe.stale, true, `the aged unowned lock ${JSON.stringify(token)} is recoverable`);

      await appendEditAudit({ ...input({ plan: plan(`docs/u${index}.md`) }), siteRoot: root, ledger });
      assert.equal(completeLines(ledger).length, 1, `${JSON.stringify(token)}: the record landed whole`);
      assert.equal(existsSync(lock), false, "the recovered lock is gone after the append");
    }

    // A young unowned lock is not stolen either: the writer still waits, bounded by its timeout.
    const fresh = join(root, "fresh.jsonl");
    const freshLock = `${fresh}.lock`;
    writeFileSync(freshLock, "", "utf8");
    const probe = await auditLockInternals.probeStaleLock(freshLock);
    assert.ok(probe !== undefined);
    assert.equal(probe.stale, false, "a young unowned lock may still be a lock being created");
    rmSync(freshLock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after a timeout and a recovery the ledger keeps every record whole and exactly once", async () => {
  const root = scratch();
  const ledger = join(root, "ledger.jsonl");
  const lock = `${ledger}.lock`;
  try {
    const line = formatEditAudit(createEditAudit(input()));
    await appendEditAudit({ ...input(), siteRoot: root, ledger });

    const holder = lockChild(lock);
    try {
      JSON.parse(await holder.send("acquire"));
      const past = oneHourAgo();
      utimesSync(lock, past, past);

      await assert.rejects(
        appendEditAudit({ ...input(), siteRoot: root, ledger, lockTimeoutMs: 100 }),
        (error: unknown) => error instanceof EditAuditError && error.code === "ledger-locked",
      );
      assert.equal(readFileSync(ledger, "utf8"), line, "the timed-out duplicate append changed nothing");
    } finally {
      await holder.kill();
    }

    await appendEditAudit({ ...input(), siteRoot: root, ledger, lockTimeoutMs: 5_000 });
    assert.deepEqual(completeLines(ledger), [line.slice(0, -1)], "the dead owner's recovery kept one copy");

    await appendEditAudit({ ...input({ plan: plan("docs/c.md") }), siteRoot: root, ledger });
    const lines = completeLines(ledger);
    assert.equal(lines.length, 2, "both distinct records are present");
    assert.equal(new Set(lines).size, 2, "neither record is duplicated");
    assert.deepEqual((await verifyEditAuditLedger(ledger)).issues, []);
    assert.equal(existsSync(lock), false, "no lock is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aged lock held by a live append in this process is never stolen, and concurrent appends keep every record", async () => {
  const root = scratch();
  const ledger = join(root, "ledger.jsonl");
  const lock = `${ledger}.lock`;
  try {
    await appendEditAudit({ ...input(), siteRoot: root, ledger });
    const before = readFileSync(ledger, "utf8");

    // The append whose lock this is is still running in this process, just slower than the stale age.
    const held = await auditLockInternals.acquireLedgerLock(lock, 5_000);
    const past = oneHourAgo();
    utimesSync(lock, past, past);

    const probe = await auditLockInternals.probeStaleLock(lock);
    assert.ok(probe !== undefined);
    assert.equal(probe.stale, false, "the token this process is actively holding is live, whatever its age");
    assert.equal(await auditLockInternals.breakStaleLock(lock), false, "a competing breaker cannot remove it");
    assert.equal(readFileSync(lock, "utf8"), held.token, "the live append's lock is still in place");

    // Two appends racing in this process must wait, not rename over the live holder, and lose nothing.
    const results = await Promise.allSettled([
      appendEditAudit({ ...input({ plan: plan("docs/live-a.md") }), siteRoot: root, ledger, lockTimeoutMs: 100 }),
      appendEditAudit({ ...input({ plan: plan("docs/live-b.md") }), siteRoot: root, ledger, lockTimeoutMs: 100 }),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok(result.status === "rejected" && result.reason instanceof EditAuditError && result.reason.code === "ledger-locked");
    }
    assert.equal(readFileSync(ledger, "utf8"), before, "the blocked appends wrote nothing");
    assert.equal(readFileSync(lock, "utf8"), held.token, "the timed-out appends left the live lock alone");

    await auditLockInternals.releaseLedgerLock(held);
    await Promise.all([
      appendEditAudit({ ...input({ plan: plan("docs/live-a.md") }), siteRoot: root, ledger }),
      appendEditAudit({ ...input({ plan: plan("docs/live-b.md") }), siteRoot: root, ledger }),
    ]);
    const lines = completeLines(ledger);
    assert.equal(lines.length, 3, "both racing appends landed once beside the existing record");
    assert.equal(new Set(lines).size, 3, "no record was overwritten or duplicated");
    assert.deepEqual((await verifyEditAuditLedger(ledger)).issues, []);
    assert.equal(existsSync(lock), false, "no lock is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aged token naming this process but no longer held is recovered, not trusted as live", async () => {
  const root = scratch();
  const ledger = join(root, "ledger.jsonl");
  const lock = `${ledger}.lock`;
  try {
    writeFileSync(lock, `${process.pid} 999999`, "utf8");
    const past = oneHourAgo();
    utimesSync(lock, past, past);

    const probe = await auditLockInternals.probeStaleLock(lock);
    assert.ok(probe !== undefined);
    assert.equal(probe.stale, true, "an inactive token with this process's PID is still recoverable");

    await appendEditAudit({ ...input(), siteRoot: root, ledger, lockTimeoutMs: 5_000 });
    assert.equal(completeLines(ledger).length, 1, "the append recovered the abandoned token and wrote one record");
    assert.equal(existsSync(lock), false, "the recovered lock is gone after the append");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
