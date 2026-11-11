/**
 * One line of the agent-edit provenance ledger (#11, M2.4).
 *
 * A record names the plan it belongs to (`plan`: the source file, the span, and the SHA-256 of the
 * source before and after), how the plan ended (`outcome`), and the verification that followed it.
 * `id` is a SHA-256 over the plan's identity, so an applied plan and its record correlate without a
 * wall-clock timestamp.
 *
 * The ledger is append-only: a record is never edited in place, and a rejected plan is recorded as
 * `rejected` rather than as an applied plan with an empty result. These are the types only; the
 * writer lives in `src/edits/audit.ts`.
 */

/** The ledger format version. Only 1 exists. */
export type EditAuditVersion = 1;

/** How a plan ended. `rejected` means nothing was written to the source. */
export type EditAuditOutcome = "applied" | "rejected";

/** How one check, or the verification as a whole, ended. */
export type EditAuditCheckStatus = "passed" | "failed" | "skipped";

/** One source span, 1-based lines and columns, the end inclusive. */
export interface EditAuditSpan {
  /** Line where the replaced text starts. */
  readonly line: number;
  /** Column where the replaced text starts, in Unicode code points. */
  readonly column: number;
  /** Line where the replaced text ends. */
  readonly endLine: number;
  /** Column of the span's last character, inclusive. */
  readonly endColumn: number;
}

/** The plan the record is about: where it applied and the hashes on each side. */
export interface EditAuditPlan {
  /** The source file, relative to the site root, with forward slashes. */
  readonly file: string;
  /** The span the plan replaced. */
  readonly span: EditAuditSpan;
  /** SHA-256 of the whole source the plan was computed from. */
  readonly beforeHash: string;
  /** SHA-256 of the whole source after the plan; `null` when the plan was rejected. */
  readonly afterHash: string | null;
}

/** One verification check recorded for a plan. */
export interface EditAuditCheck {
  /** A stable identifier for the check, such as `doctor.L1`. */
  readonly id: string;
  /** How the check ended. */
  readonly status: EditAuditCheckStatus;
  /** What the check found, with credentials and machine-local paths redacted. */
  readonly message?: string;
  /** The file the check is about, relative to the site root, with forward slashes. */
  readonly file?: string;
  /** The line, 1-based, front matter included. */
  readonly line?: number;
}

/** The verification that followed a plan. A plan whose verification did not run has no checks. */
export interface EditAuditVerification {
  /** The worst status the checks support. `skipped` means no verification ran. */
  readonly status: EditAuditCheckStatus;
  /** The checks, sorted by id comparing code points. */
  readonly checks: readonly EditAuditCheck[];
}

/** One ledger record, as written to disk. */
export interface EditAuditRecord {
  /** The format version, always 1. */
  readonly version: EditAuditVersion;
  /** SHA-256 over the plan's identity; the key that correlates a plan with its record. */
  readonly id: string;
  /** How the plan ended. */
  readonly outcome: EditAuditOutcome;
  /** The plan the record is about. */
  readonly plan: EditAuditPlan;
  /** The verification that followed the plan. */
  readonly verification: EditAuditVerification;
  /**
   * When the plan ended, ISO 8601 UTC. Present only when the caller passed a date or
   * `SOURCE_DATE_EPOCH` was set; the writer never reads the wall clock.
   */
  readonly date?: string;
}
