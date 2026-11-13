import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditAudit, formatEditAudit } from "../src/edits/audit.ts";
import {
  EDIT_AUDIT_MAX_RECORD_BYTES,
  verifyEditAuditLedger,
  type EditAuditLedgerReport,
} from "../src/edits/audit-verify.ts";

/** The date every test uses, so nothing depends on the wall clock. */
const DATE = "2026-01-01T00:00:00.000Z";

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "edits-audit-verify-limits-"));
}

/**
 * One valid canonical record whose ledger line, without its line feed, is exactly `bytes` bytes.
 * The message is plain `a`s, so it grows by one byte per character and never looks like a secret.
 */
function sizedRecord(bytes: number): string {
  const line = (messageLength: number): string =>
    formatEditAudit(
      createEditAudit({
        outcome: "applied",
        plan: {
          file: "docs/a.md",
          span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
        },
        date: DATE,
        verification: {
          status: "passed",
          checks: [{ id: "doctor.L1", status: "passed", message: "a".repeat(messageLength) }],
        },
      }),
    ).slice(0, -1);
  const base = line(1);
  const text = line(1 + bytes - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(text), bytes, "the fixture is exactly the requested size");
  return text;
}

/** The issues as `line:code` pairs, so a test names the exact line and reason in one assert. */
function issues(report: EditAuditLedgerReport): string[] {
  return report.issues.map((issue) => `${issue.line}:${issue.code}`);
}

test("an oversized record fails with a stable code and never reaches JSON.parse", async () => {
  const root = scratch();
  const original = JSON.parse;
  let parsedBytes = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    parsedBytes = Math.max(parsedBytes, Buffer.byteLength(text));
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    const ledger = join(root, "oversized.jsonl");
    writeFileSync(ledger, `${sizedRecord(EDIT_AUDIT_MAX_RECORD_BYTES + 1)}\n`, "utf8");

    const report = await verifyEditAuditLedger(ledger);
    assert.deepEqual(report, {
      ok: false,
      records: 0,
      issues: [
        {
          code: "oversized-record",
          line: 1,
          message: `the line is longer than ${EDIT_AUDIT_MAX_RECORD_BYTES} bytes; it was not parsed.`,
        },
      ],
    });
    assert.ok(parsedBytes <= EDIT_AUDIT_MAX_RECORD_BYTES, `JSON.parse saw ${parsedBytes} bytes`);
  } finally {
    JSON.parse = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid record after an oversized line is still inspected and counted", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "ledger.jsonl");
    const first = formatEditAudit(
      createEditAudit({
        outcome: "applied",
        plan: {
          file: "docs/first.md",
          span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
        },
        date: DATE,
      }),
    );
    const later = formatEditAudit(
      createEditAudit({
        outcome: "applied",
        plan: {
          file: "docs/later.md",
          span: { line: 2, column: 1, endLine: 2, endColumn: 5 },
          beforeHash: "c".repeat(64),
          afterHash: "d".repeat(64),
        },
        date: DATE,
      }),
    );
    writeFileSync(
      ledger,
      first + sizedRecord(EDIT_AUDIT_MAX_RECORD_BYTES * 2) + "\n" + later,
      "utf8",
    );

    const report = await verifyEditAuditLedger(ledger);
    assert.deepEqual(issues(report), ["2:oversized-record"]);
    assert.equal(report.records, 2);
    assert.equal(report.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record exactly at the limit is accepted and one byte more is refused", async () => {
  const root = scratch();
  try {
    const boundary = join(root, "boundary.jsonl");
    writeFileSync(boundary, `${sizedRecord(EDIT_AUDIT_MAX_RECORD_BYTES)}\n`, "utf8");
    assert.deepEqual(await verifyEditAuditLedger(boundary), { ok: true, records: 1, issues: [] });

    const over = join(root, "over.jsonl");
    writeFileSync(over, `${sizedRecord(EDIT_AUDIT_MAX_RECORD_BYTES + 1)}\n`, "utf8");
    assert.deepEqual(issues(await verifyEditAuditLedger(over)), ["1:oversized-record"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized final line without a line feed is both oversized and truncated", async () => {
  const root = scratch();
  try {
    const ledger = join(root, "unterminated.jsonl");
    writeFileSync(ledger, sizedRecord(EDIT_AUDIT_MAX_RECORD_BYTES + 1), "utf8");

    const report = await verifyEditAuditLedger(ledger);
    assert.deepEqual(issues(report), ["1:oversized-record", "1:truncated-line"]);
    assert.equal(report.records, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
