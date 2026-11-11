/**
 * The coverage half of `mizzen doctor`: which preflight checks ran and how each ended.
 *
 * A check that passed adds no finding, so the text, JSON, and SARIF of a clean site stay exactly as they were. A check
 * that was skipped adds one `info` finding, so machine-readable output can never present a subset of the checks as if
 * it were the whole run; `info` never fails a site. A failed check is already named by the error findings it made.
 */
import type { Diagnostic } from "../contracts/index.ts";

/** Every preflight check, in the order a report lists them. */
export const DOCTOR_CHECKS = ["runtime", "config", "content", "theme", "render", "output"] as const;

/** The stable id of one preflight check. */
export type DoctorCheckId = (typeof DOCTOR_CHECKS)[number];

/** Whether a check ran and passed, ran and found an error, or could not run. */
export type DoctorCheckState = "passed" | "failed" | "skipped";

/** One check's outcome. `reason` is present whenever the check did not pass, so a skip is never unexplained. */
export type DoctorCheck =
  | { readonly id: DoctorCheckId; readonly state: "passed" }
  | { readonly id: DoctorCheckId; readonly state: "failed"; readonly reason: string }
  | { readonly id: DoctorCheckId; readonly state: "skipped"; readonly reason: string };

/** One doctor run: what it found and how every declared check ended. */
export interface DoctorReport {
  /** Every declared check, in {@link DOCTOR_CHECKS} order. */
  readonly checks: readonly DoctorCheck[];
  /** The findings, sorted, with the coverage findings of skipped checks included. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The finding id that records a skipped check. */
export const SKIPPED_CHECK = "doctor.check-skipped";

/** One `info` finding per skipped check, in report order. */
export function coverageDiagnostics(checks: readonly DoctorCheck[]): readonly Diagnostic[] {
  return checks
    .filter((check): check is Extract<DoctorCheck, { state: "skipped" }> => check.state === "skipped")
    .map((check) => ({
      id: SKIPPED_CHECK,
      severity: "info" as const,
      message: `The ${check.id} check was skipped: ${check.reason}.`,
      help: "Fix the finding named above, then run `mizzen doctor` again.",
    }));
}
