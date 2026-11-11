/**
 * The agent-edit provenance ledger (#11, M2.4).
 *
 * Every applied or rejected edit plan appends one record to one JSON Lines ledger. The record
 * ([EditAuditRecord](../contracts/edit-audit.ts)) names the plan's file and span, the SHA-256 of the
 * source before and after, and the verification that followed it, so a reviewer can correlate an
 * applied plan with the bytes it changed and the checks that judged it.
 *
 * Three rules keep the ledger trustworthy:
 *
 * - **Append-only.** A record is one line and a write never rewrites an existing line: the new line
 *   is added to the bytes already there and one rename puts the result in place, so a reader never
 *   sees half a record. A ledger that does not end with a line feed is refused, not repaired.
 * - **Deterministic.** There is no wall-clock timestamp unless the caller passes a date or
 *   `SOURCE_DATE_EPOCH` is set, as `src/edits/proof.ts` does. Checks are sorted by id, keys are
 *   written in one fixed order, and the same input gives the same line. The record's `id` is a
 *   SHA-256 over the plan's identity, so repeating the same plan does not append a second copy.
 * - **No secrets, no machine paths.** The record's fields are built one by one from the input, never
 *   copied wholesale, so an environment dump cannot ride along. Free text is redacted
 *   deterministically: credential assignments, bearer tokens, known token shapes, and absolute
 *   machine-local paths become `<redacted>` or `<path>`.
 *
 * A rejected plan is recorded as `rejected` with no `afterHash` and no verification; a record that
 * claims `applied` without an after hash, or `rejected` with a passing verification, is refused
 * before anything is written.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type {
  EditAuditCheck,
  EditAuditCheckStatus,
  EditAuditOutcome,
  EditAuditPlan,
  EditAuditRecord,
  EditAuditSpan,
  EditAuditVerification,
} from "../contracts/index.ts";

/** The ledger format version. Only 1 exists. */
export const EDIT_AUDIT_VERSION = 1;

/** What {@link createEditAudit} needs. Everything but the plan and the outcome is optional. */
export interface EditAuditInput {
  /** The plan the record is about. */
  readonly plan: EditAuditPlan;
  /** How the plan ended. */
  readonly outcome: EditAuditOutcome;
  /** The verification that followed the plan. Omitted means it did not run. */
  readonly verification?: EditAuditVerification;
  /**
   * The plan's date, as an ISO 8601 string or a `Date`. Default: `SOURCE_DATE_EPOCH` when the
   * environment sets it, else no `date` field. An explicit date always wins.
   */
  readonly date?: string | Date;
}

/** What {@link appendEditAudit} needs: a {@link EditAuditInput} and where the ledger lives. */
export interface AppendEditAuditOptions extends EditAuditInput {
  /** The site root a relative `ledger` is resolved against, and the base of the plan's paths. */
  readonly siteRoot: string;
  /** The ledger file. A relative path is resolved against `siteRoot`; parent folders are created. */
  readonly ledger: string;
}

/** Why a record or a ledger was refused. Each code names one check so a caller can tell them apart. */
export type EditAuditErrorCode = "invalid-plan" | "invalid-verification" | "invalid-date" | "invalid-ledger";

/** A refused audit record or ledger. Nothing is written when this is thrown. */
export class EditAuditError extends Error {
  readonly code: EditAuditErrorCode;

  constructor(code: EditAuditErrorCode, message: string) {
    super(message);
    this.name = "EditAuditError";
    this.code = code;
  }
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Redactions, applied in this order. Each pattern is global, so a message is redacted whole. */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // A credential named anywhere in the key, in `name=value` or `name: value` form, environment style
  // included. A scheme before the value (`Authorization: Bearer …`) is consumed with it.
  [
    /\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?("[^"]*"|'[^']*'|[^\s,;&"'`]+)/gi,
    "$1$2<redacted>",
  ],
  // An authentication scheme and its token, when no key names it.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>"],
  // Token shapes that are recognisable without a key.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b/g,
    "<redacted>",
  ],
  // An absolute machine-local path: a Unix or Windows root, or a `~` home. A path inside a URL is
  // left alone because its first slash follows a scheme or a host.
  [/(?<![\w.:/-])(?:\b[A-Za-z]:[\\/]|~\/|\/)[^\s"'`,;:)\]]+/g, "<path>"],
];

/** Redacts credentials and absolute machine-local paths from free text, deterministically. */
export function redactAuditText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTIONS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** The record's form of a path: relative, forward slashes, and no way out of the site root. */
function auditPath(file: string, where: string, code: EditAuditErrorCode = "invalid-plan"): string {
  if (
    typeof file !== "string" ||
    file === "" ||
    file === "." ||
    file.startsWith("/") ||
    file.includes("\\") ||
    /[\r\n]/.test(file) ||
    /^[a-zA-Z]:/.test(file) ||
    file.split("/").includes("..")
  ) {
    throw new EditAuditError(
      code,
      `audit: ${where} is not a file relative to the site root; use a relative path with forward slashes and no ".." segment.`,
    );
  }
  return file;
}

/** A positive whole line or column. */
function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** The plan's span, refusing one that is not a usable 1-based span. */
function spanRecord(span: EditAuditSpan): EditAuditSpan {
  for (const key of ["line", "column", "endLine", "endColumn"] as const) {
    if (!positiveInteger(span[key])) {
      throw new EditAuditError("invalid-plan", `audit: the plan's span.${key} is not a 1-based whole number.`);
    }
  }
  if (span.endLine < span.line || (span.endLine === span.line && span.endColumn < span.column)) {
    throw new EditAuditError("invalid-plan", "audit: the plan's span ends before it starts.");
  }
  return { line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn };
}

/** A SHA-256, lowercased so two spellings of the same hash serialize the same way. */
function hashRecord(value: string | null, where: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new EditAuditError("invalid-plan", `audit: ${where} is not a SHA-256.`);
  }
  const hash = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new EditAuditError("invalid-plan", `audit: ${where} is not 64 hexadecimal characters.`);
  }
  return hash;
}

/** The plan with only the kept fields, in a fixed key order, refused when it cannot be applied. */
function planRecord(plan: EditAuditPlan, outcome: EditAuditOutcome): EditAuditPlan {
  const span = (plan as { readonly span?: EditAuditSpan }).span;
  if (span === undefined || span === null) {
    throw new EditAuditError("invalid-plan", "audit: the plan has no span.");
  }
  const beforeHash = hashRecord(plan.beforeHash, "the plan's beforeHash");
  if (beforeHash === null) {
    throw new EditAuditError("invalid-plan", "audit: the plan needs the beforeHash of the source it changed.");
  }
  const afterHash = hashRecord(plan.afterHash, "the plan's afterHash");
  if (outcome === "applied" && afterHash === null) {
    throw new EditAuditError(
      "invalid-plan",
      "audit: an applied plan needs the afterHash of the source it wrote; a rejected plan records no after hash.",
    );
  }
  if (outcome === "rejected" && afterHash !== null) {
    throw new EditAuditError(
      "invalid-plan",
      "audit: a rejected plan cannot record an after hash; nothing was written to the source.",
    );
  }
  return {
    file: auditPath(plan.file, `the plan's file ${JSON.stringify(plan.file)}`),
    span: spanRecord(span),
    beforeHash,
    afterHash,
  };
}

/** One check with its free text redacted, in a fixed key order. */
function checkRecord(check: EditAuditCheck): EditAuditCheck {
  if (typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(check.id)) {
    throw new EditAuditError(
      "invalid-verification",
      `audit: ${JSON.stringify(check.id)} is not a check id; use letters, digits, dot, underscore, or dash.`,
    );
  }
  if (check.status !== "passed" && check.status !== "failed" && check.status !== "skipped") {
    throw new EditAuditError("invalid-verification", `audit: check "${check.id}" has an unknown status.`);
  }

  const record: {
    id: string;
    status: EditAuditCheckStatus;
    message?: string;
    file?: string;
    line?: number;
  } = { id: check.id, status: check.status };

  if (check.message !== undefined) {
    if (typeof check.message !== "string" || check.message === "") {
      throw new EditAuditError("invalid-verification", `audit: check "${check.id}" has an empty message.`);
    }
    if (/[\r\n]/.test(check.message)) {
      throw new EditAuditError(
        "invalid-verification",
        `audit: check "${check.id}" has a multi-line message; the ledger keeps one check per line.`,
      );
    }
    record.message = redactAuditText(check.message);
  }
  if (check.file !== undefined) {
    record.file = auditPath(check.file, `the file of check "${check.id}"`, "invalid-verification");
  }
  if (check.line !== undefined) {
    if (!positiveInteger(check.line)) {
      throw new EditAuditError("invalid-verification", `audit: check "${check.id}" has an invalid line.`);
    }
    record.line = check.line;
  }
  return record;
}

/**
 * The verification, sorted by check id, refusing one that claims more than its checks support. An
 * applied plan may carry a failed verification; a rejected plan must not claim one ran.
 */
function verificationRecord(
  verification: EditAuditVerification | undefined,
  outcome: EditAuditOutcome,
): EditAuditVerification {
  if (outcome === "rejected") {
    if (verification !== undefined && (verification.status !== "skipped" || verification.checks.length > 0)) {
      throw new EditAuditError(
        "invalid-verification",
        "audit: a rejected plan has no verification; a passing or failing result would misstate it.",
      );
    }
    return { status: "skipped", checks: [] };
  }

  if (verification === undefined) return { status: "skipped", checks: [] };
  const status = verification.status;
  if (status !== "passed" && status !== "failed" && status !== "skipped") {
    throw new EditAuditError("invalid-verification", `audit: ${String(status)} is not a verification status.`);
  }

  const seen = new Set<string>();
  const checks = verification.checks.map((check) => {
    const record = checkRecord(check);
    if (seen.has(record.id)) {
      throw new EditAuditError("invalid-verification", `audit: check "${record.id}" is listed more than once.`);
    }
    seen.add(record.id);
    return record;
  });
  checks.sort((a, b) => byCodePoint(a.id, b.id));

  const failed = checks.filter((check) => check.status === "failed").length;
  if (status === "skipped" && checks.length > 0) {
    throw new EditAuditError(
      "invalid-verification",
      "audit: a skipped verification has no checks; record the checks with a passed or failed status.",
    );
  }
  if (status !== "skipped" && checks.length === 0) {
    throw new EditAuditError(
      "invalid-verification",
      `audit: a ${status} verification needs at least one check; use skipped when none ran.`,
    );
  }
  if (status === "passed" && failed > 0) {
    throw new EditAuditError(
      "invalid-verification",
      `audit: the verification claims to pass but ${failed} check${failed === 1 ? "" : "s"} failed.`,
    );
  }
  if (status === "failed" && failed === 0) {
    throw new EditAuditError(
      "invalid-verification",
      "audit: the verification claims to fail but no check failed.",
    );
  }
  return { status, checks };
}

/** An ISO 8601 UTC date, from the caller's date or the epoch. Never the wall clock. */
function recordDate(input: EditAuditInput): string | undefined {
  if (input.date !== undefined) {
    const date = input.date instanceof Date ? input.date : new Date(input.date);
    if (Number.isNaN(date.getTime())) {
      throw new EditAuditError("invalid-date", `audit: ${JSON.stringify(String(input.date))} is not a date.`);
    }
    return date.toISOString();
  }

  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === "") return undefined;
  if (!/^[0-9]+$/.test(epoch)) {
    throw new EditAuditError(
      "invalid-date",
      `audit: SOURCE_DATE_EPOCH is "${epoch}"; expected whole seconds since the Unix epoch.`,
    );
  }
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds)) {
    throw new EditAuditError("invalid-date", `audit: SOURCE_DATE_EPOCH is "${epoch}", which is too large.`);
  }
  return new Date(seconds * 1000).toISOString();
}

/** The record's `id`: a SHA-256 over the plan's identity, in one fixed key order. */
function auditId(outcome: EditAuditOutcome, plan: EditAuditPlan): string {
  const identity = JSON.stringify({
    version: EDIT_AUDIT_VERSION,
    outcome,
    plan: {
      file: plan.file,
      span: { line: plan.span.line, column: plan.span.column, endLine: plan.span.endLine, endColumn: plan.span.endColumn },
      beforeHash: plan.beforeHash,
      afterHash: plan.afterHash,
    },
  });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

/**
 * Builds one record without touching the filesystem. Every check runs here, so a caller that gets a
 * record back knows it is complete; {@link appendEditAudit} writes only what this returns.
 */
export function createEditAudit(input: EditAuditInput): EditAuditRecord {
  if (input.outcome !== "applied" && input.outcome !== "rejected") {
    throw new EditAuditError("invalid-plan", `audit: ${String(input.outcome)} is not an edit outcome.`);
  }
  const plan = planRecord(input.plan, input.outcome);
  const verification = verificationRecord(input.verification, input.outcome);
  const date = recordDate(input);
  return {
    version: EDIT_AUDIT_VERSION,
    id: auditId(input.outcome, plan),
    outcome: input.outcome,
    plan,
    verification,
    ...(date === undefined ? {} : { date }),
  };
}

/** The record's ledger line: one compact JSON object, keys in record order, one line feed. */
export function formatEditAudit(record: EditAuditRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Writes `text` whole: a fresh folder beside the target, one file, then one rename into place. */
async function writeAtomic(out: string, text: string): Promise<void> {
  const folder = dirname(out);
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(`${folder}${sep}.edit-audit-`);
  try {
    const temp = `${staging}${sep}ledger.jsonl`;
    await writeFile(temp, text, "utf8");
    await rename(temp, out);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Appends one record to the ledger at `ledger` and returns it. The record is built and checked
 * first, so a refusal leaves the ledger byte-identical. A line that is already present is not
 * appended twice, so replaying the same plan is a no-op.
 */
export async function appendEditAudit(options: AppendEditAuditOptions): Promise<EditAuditRecord> {
  const record = createEditAudit(options);
  const line = formatEditAudit(record);
  const out = isAbsolute(options.ledger) ? options.ledger : resolve(options.siteRoot, options.ledger);

  let existing = "";
  try {
    existing = await readFile(out, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EditAuditError("invalid-ledger", `audit: cannot read the ledger at "${out}": ${reason}`);
    }
  }
  if (existing !== "" && !existing.endsWith("\n")) {
    throw new EditAuditError(
      "invalid-ledger",
      `audit: the ledger at "${out}" does not end with a line feed; refusing to append to a damaged ledger.`,
    );
  }
  if (existing.split("\n").includes(line.slice(0, -1))) return record;

  // shortcut: two processes appending at once can lose a line; the edit CLI applies one plan at a time.
  await writeAtomic(out, existing + line);
  return record;
}
