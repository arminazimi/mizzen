/**
 * Read-only verification of one agent-edit ledger (#59, M2.7).
 *
 * The ledger is only useful to a reviewer if its lines can be trusted. This module streams the
 * JSON Lines file once and reports, for the exact 1-based line, every reason a record fails:
 *
 * - **Shape.** One JSON object per line, the fixed key sets, the version, whole spans, and the
 *   applied/rejected fields.
 * - **Canonical ids.** `id` must equal the SHA-256 {@link editAuditId} computes over the plan, so a
 *   record cannot name a plan it does not describe.
 * - **Paths and hashes.** Paths stay relative to the site root; hashes are lowercase SHA-256, and an
 *   applied record has an after hash while a rejected one does not.
 * - **Verification consistency.** Checks are sorted, have no duplicate ids, and support their
 *   verification's status; a rejected record carries no verification.
 * - **Redaction.** A message the writer would have redacted is reported, because a credential or a
 *   machine-local path reached the ledger.
 * - **Terminal newlines.** A last line without a line feed is reported as truncated, never parsed
 *   as if it were complete.
 *
 * Duplicates are the same record twice: the whole canonical line, not just the `id`. The same plan
 * verified with different evidence is two legitimate records and is not conflated.
 *
 * The file is read in chunks, so a damaged ledger does not have to fit in memory before it can be
 * judged. Verification writes nothing.
 */
import { createReadStream } from "node:fs";
import type {
  EditAuditCheck,
  EditAuditCheckStatus,
  EditAuditOutcome,
  EditAuditPlan,
  EditAuditRecord,
  EditAuditVerification,
} from "../contracts/index.ts";
import {
  EDIT_AUDIT_CHECK_ID,
  EDIT_AUDIT_VERSION,
  EditAuditError,
  editAuditId,
  formatEditAudit,
  isEditAuditHash,
  isEditAuditPath,
  redactAuditText,
} from "./audit.ts";

/** Why one ledger line was rejected. Each code names one check, so a caller can tell them apart. */
export type EditAuditIssueCode =
  | "truncated-line"
  | "empty-line"
  | "malformed-json"
  | "invalid-record"
  | "invalid-id"
  | "duplicate-record"
  | "invalid-path"
  | "invalid-hash"
  | "invalid-check"
  | "unredacted-credential"
  | "unredacted-path";

/** One refused line. */
export interface EditAuditIssue {
  /** The stable reason. */
  readonly code: EditAuditIssueCode;
  /** The 1-based line the issue is on. */
  readonly line: number;
  /** What is wrong, without the line number repeated. */
  readonly message: string;
}

/** What {@link verifyEditAuditLedger} found. */
export interface EditAuditLedgerReport {
  /** True when every line was one complete, canonical record. */
  readonly ok: boolean;
  /** How many complete lines held a structurally valid record. */
  readonly records: number;
  /** Every reason the ledger is not trustworthy, in line order. */
  readonly issues: readonly EditAuditIssue[];
}

/** A JSON object from a parsed line, before its fields are checked. */
type JsonObject = Record<string, unknown>;

/** Record keys: required, then the optional date. */
const RECORD_KEYS = ["version", "id", "outcome", "plan", "verification"] as const;
const RECORD_OPTIONAL_KEYS = ["date"] as const;
const PLAN_KEYS = ["file", "span", "beforeHash", "afterHash"] as const;
const SPAN_KEYS = ["line", "column", "endLine", "endColumn"] as const;
const VERIFICATION_KEYS = ["status", "checks"] as const;
const CHECK_KEYS = ["id", "status"] as const;
const CHECK_OPTIONAL_KEYS = ["message", "file", "line"] as const;

/** An ISO 8601 UTC instant in the writer's one spelling. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A parsed line is one JSON object, never an array or null. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 1-based whole line or column. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A check or verification status. */
function isStatus(value: unknown): value is EditAuditCheckStatus {
  return value === "passed" || value === "failed" || value === "skipped";
}

/** A date the writer would have produced: canonical ISO 8601 UTC. */
function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * The keys `value` has that it must not, or the ones it lacks; `undefined` when the set matches.
 * `where` names the object in the message, such as "the plan".
 */
function keyProblem(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  where: string,
): string | undefined {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) return `${where} is missing ${missing.join(", ")}.`;
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) return `${where} has unexpected ${extra.join(", ")}.`;
  return undefined;
}

/** One line's record, when its shape was sound enough to rebuild, and the reasons it failed. */
interface CheckedRecord {
  readonly record: EditAuditRecord | undefined;
  readonly issues: readonly EditAuditIssue[];
}

/**
 * Checks one parsed line. A structural problem (`undefined` record) means no later check can trust
 * the fields; semantic problems still leave a reconstructed record so duplicates can be found.
 */
function checkRecord(value: JsonObject, line: number): CheckedRecord {
  const issues: EditAuditIssue[] = [];
  const issue = (code: EditAuditIssueCode, message: string): void => {
    issues.push({ code, line, message });
  };
  const broken = (code: EditAuditIssueCode, message: string): CheckedRecord => {
    issue(code, message);
    return { record: undefined, issues };
  };

  let problem = keyProblem(value, RECORD_KEYS, RECORD_OPTIONAL_KEYS, "the record");
  if (problem !== undefined) return broken("invalid-record", problem);
  if (value.version !== EDIT_AUDIT_VERSION) {
    return broken("invalid-record", `the version is ${JSON.stringify(value.version)}; expected ${EDIT_AUDIT_VERSION}.`);
  }
  if (typeof value.id !== "string") return broken("invalid-id", "the id is not a string.");
  if (value.outcome !== "applied" && value.outcome !== "rejected") {
    return broken("invalid-record", `the outcome ${JSON.stringify(value.outcome)} is not applied or rejected.`);
  }
  const outcome: EditAuditOutcome = value.outcome;

  const plan = value.plan;
  if (!isObject(plan)) return broken("invalid-record", "the plan is not an object.");
  problem = keyProblem(plan, PLAN_KEYS, [], "the plan");
  if (problem !== undefined) return broken("invalid-record", problem);
  if (typeof plan.file !== "string") return broken("invalid-path", "the plan's file is not a string.");

  const span = plan.span;
  if (!isObject(span)) return broken("invalid-record", "the plan's span is not an object.");
  problem = keyProblem(span, SPAN_KEYS, [], "the span");
  if (problem !== undefined) return broken("invalid-record", problem);
  const { line: startLine, column, endLine, endColumn } = span;
  if (
    !isPositiveInteger(startLine) ||
    !isPositiveInteger(column) ||
    !isPositiveInteger(endLine) ||
    !isPositiveInteger(endColumn)
  ) {
    return broken("invalid-record", "the span is not four 1-based whole numbers.");
  }
  if (endLine < startLine || (endLine === startLine && endColumn < column)) {
    return broken("invalid-record", "the span ends before it starts.");
  }

  const { beforeHash, afterHash } = plan;
  if (typeof beforeHash !== "string" || (afterHash !== null && typeof afterHash !== "string")) {
    return broken("invalid-record", "the plan's beforeHash or afterHash is not a string or null.");
  }

  const verification = value.verification;
  if (!isObject(verification)) return broken("invalid-record", "the verification is not an object.");
  problem = keyProblem(verification, VERIFICATION_KEYS, [], "the verification");
  if (problem !== undefined) return broken("invalid-record", problem);
  if (!isStatus(verification.status)) {
    return broken("invalid-check", `the verification's status ${JSON.stringify(verification.status)} is unknown.`);
  }
  if (!Array.isArray(verification.checks)) return broken("invalid-check", "the verification's checks are not a list.");

  const checks: EditAuditCheck[] = [];
  for (const entry of verification.checks) {
    if (!isObject(entry)) return broken("invalid-check", "a check is not an object.");
    problem = keyProblem(entry, CHECK_KEYS, CHECK_OPTIONAL_KEYS, `check ${JSON.stringify(entry.id)}`);
    if (problem !== undefined) return broken("invalid-check", problem);
    if (typeof entry.id !== "string" || !EDIT_AUDIT_CHECK_ID.test(entry.id)) {
      return broken("invalid-check", `${JSON.stringify(entry.id)} is not a check id.`);
    }
    if (!isStatus(entry.status)) {
      return broken("invalid-check", `check "${entry.id}" has an unknown status.`);
    }
    if (
      entry.message !== undefined &&
      (typeof entry.message !== "string" || entry.message === "" || /[\r\n]/.test(entry.message))
    ) {
      return broken("invalid-check", `check "${entry.id}" has no usable single-line message.`);
    }
    if (entry.file !== undefined && typeof entry.file !== "string") {
      return broken("invalid-check", `check "${entry.id}" has a file that is not a string.`);
    }
    if (entry.line !== undefined && !isPositiveInteger(entry.line)) {
      return broken("invalid-check", `check "${entry.id}" has an invalid line.`);
    }
    checks.push({
      id: entry.id,
      status: entry.status,
      ...(entry.message === undefined ? {} : { message: entry.message }),
      ...(entry.file === undefined ? {} : { file: entry.file }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
    });
  }

  const date = value.date;
  if (date !== undefined && !isCanonicalDate(date)) {
    return broken("invalid-record", `the date ${JSON.stringify(date)} is not an ISO 8601 UTC instant.`);
  }

  const typedPlan: EditAuditPlan = {
    file: plan.file,
    span: { line: startLine, column, endLine, endColumn },
    beforeHash,
    afterHash,
  };
  const typedVerification: EditAuditVerification = { status: verification.status, checks };
  const record: EditAuditRecord = {
    version: EDIT_AUDIT_VERSION,
    id: value.id,
    outcome,
    plan: typedPlan,
    verification: typedVerification,
    ...(date === undefined ? {} : { date }),
  };

  if (!isEditAuditPath(typedPlan.file)) {
    issue(
      "invalid-path",
      `the plan's file ${JSON.stringify(typedPlan.file)} is not relative to the site root with forward slashes.`,
    );
  }
  for (const check of checks) {
    if (check.file !== undefined && !isEditAuditPath(check.file)) {
      issue(
        "invalid-path",
        `check "${check.id}" has file ${JSON.stringify(check.file)}; paths are relative to the site root.`,
      );
    }
  }

  if (!isEditAuditHash(typedPlan.beforeHash)) {
    issue("invalid-hash", "the plan's beforeHash is not 64 lowercase hexadecimal characters.");
  }
  if (typedPlan.afterHash === null && outcome === "applied") {
    issue("invalid-hash", "an applied record needs an afterHash.");
  } else if (typedPlan.afterHash !== null && outcome === "rejected") {
    issue("invalid-hash", "a rejected record cannot carry an afterHash.");
  } else if (typedPlan.afterHash !== null && !isEditAuditHash(typedPlan.afterHash)) {
    issue("invalid-hash", "the plan's afterHash is not 64 lowercase hexadecimal characters.");
  }

  const expectedId = editAuditId(outcome, typedPlan);
  if (value.id !== expectedId) {
    issue("invalid-id", `the id does not match the plan; expected ${expectedId}.`);
  }

  const seenIds = new Set<string>();
  let previousId: string | undefined;
  for (const check of checks) {
    if (seenIds.has(check.id)) {
      issue("invalid-check", `check "${check.id}" is listed more than once.`);
    } else {
      if (previousId !== undefined && byCodePoint(previousId, check.id) > 0) {
        issue("invalid-check", `check "${check.id}" is out of order; checks are sorted by id.`);
      }
      previousId = check.id;
    }
    seenIds.add(check.id);
  }

  const failed = checks.filter((check) => check.status === "failed").length;
  if (typedVerification.status === "skipped" && checks.length > 0) {
    issue("invalid-check", "a skipped verification has checks.");
  }
  if (typedVerification.status !== "skipped" && checks.length === 0) {
    issue("invalid-check", `a ${typedVerification.status} verification has no checks.`);
  }
  if (typedVerification.status === "passed" && failed > 0) {
    issue("invalid-check", "the verification claims to pass but a check failed.");
  }
  if (typedVerification.status === "failed" && failed === 0) {
    issue("invalid-check", "the verification claims to fail but no check failed.");
  }
  if (outcome === "rejected" && (typedVerification.status !== "skipped" || checks.length > 0)) {
    issue("invalid-check", "a rejected record carries no verification.");
  }

  for (const check of checks) {
    if (check.message === undefined) continue;
    const redacted = redactAuditText(check.message);
    if (redacted === check.message) continue;
    issue(
      redacted.includes("<path>") && !redacted.includes("<redacted>") ? "unredacted-path" : "unredacted-credential",
      `check "${check.id}" has text the writer would have redacted.`,
    );
  }

  return { record, issues };
}

/**
 * Verifies the ledger at `ledger` and reports every line that cannot be trusted. The file is read
 * in chunks and nothing is written; a missing ledger is an `invalid-ledger` refusal.
 */
export async function verifyEditAuditLedger(ledger: string): Promise<EditAuditLedgerReport> {
  const issues: EditAuditIssue[] = [];
  const seen = new Map<string, number>();
  let records = 0;
  let lineNumber = 0;
  let pending = "";

  const examine = (text: string): void => {
    lineNumber += 1;
    const line = lineNumber;
    if (text.trim() === "") {
      issues.push({ code: "empty-line", line, message: "the line is empty; every line is one record." });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      issues.push({ code: "malformed-json", line, message: `the line is not JSON: ${reason}` });
      return;
    }
    if (!isObject(value)) {
      issues.push({ code: "malformed-json", line, message: "the line is not one JSON object." });
      return;
    }

    const checked = checkRecord(value, line);
    issues.push(...checked.issues);
    if (checked.record === undefined) return;

    records += 1;
    const canonical = formatEditAudit(checked.record).slice(0, -1);
    const first = seen.get(canonical);
    if (first === undefined) {
      seen.set(canonical, line);
    } else {
      issues.push({ code: "duplicate-record", line, message: `the line repeats the record on line ${first}.` });
    }
  };

  try {
    const stream = createReadStream(ledger, { encoding: "utf8" });
    for await (const chunk of stream) {
      pending += chunk;
      let end = pending.indexOf("\n");
      while (end !== -1) {
        examine(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EditAuditError("invalid-ledger", `audit: cannot read the ledger at "${ledger}": ${reason}`);
  }

  if (pending !== "") {
    lineNumber += 1;
    issues.push({
      code: "truncated-line",
      line: lineNumber,
      message: "the line has no terminating line feed; the ledger was truncated or is still being written.",
    });
  }

  return { ok: issues.length === 0, records, issues };
}
