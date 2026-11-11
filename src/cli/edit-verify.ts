/**
 * `mizzen edit verify <proof.json> [--site <dir>] [--doctor]`: check a proof record against the working tree (#1512, #60).
 *
 * The proof record ([N29](../edits/proof.ts)) keeps the SHA-256 of every touched file after the edit, the resulting
 * source spans with the SHA-256 of the text each covers, and, optionally, the doctor's findings. This command checks
 * every one of those claims against what is on disk: each recorded path must resolve to a real path inside the site
 * root, each after hash must match, and each span must still cover the text it hashed. Every file is checked in path
 * order, so all mismatches are reported instead of only the first.
 *
 * The doctor is a separate package, so it runs as a command and never as an import: `mizzen doctor <dir> --format
 * json`, whose `diagnostics` are compared with the findings the proof recorded. A proof that records only a level, or
 * no doctor result, has no evidence the current doctor JSON can verify, so it can never be a match. Without `--doctor`
 * the files and spans are still checked and the command says that the doctor check did not run.
 *
 * A matching proof exits 0; a mismatching file, span, or finding exits 1; a proof that cannot be read, or a doctor
 * check that cannot run or has no comparable evidence, is a usage error and exits 2. `--format json` prints the same
 * outcome as one {@link VerifyProofReport}, naming every failed check and where it is.
 *
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareDoctorFindings,
  DoctorReportError,
  parseDoctorReport,
  parseProof,
  verifyProofFiles,
  type ParsedProof,
  type ProofVerifyIssue,
} from "../edits/proof-verifier.ts";
import { formatPatchSpan } from "../edits/patch.ts";
import type { ProofLevel, ProofSpan } from "../edits/proof.ts";

/** A command that runs the doctor CLI, as an executable and the arguments before `doctor`. */
export interface DoctorCommand {
  /** The executable, such as `mizzen` or `process.execPath`. */
  readonly command: string;
  /** Arguments before the doctor's own, used to run a TypeScript entry point through Node. */
  readonly prefix?: readonly string[];
}

/** Options of {@link verifyProof}. */
export interface VerifyProofOptions {
  /** The proof record to check. */
  readonly proof: string;
  /** The site root the record's paths are relative to. Default: the current directory. */
  readonly siteRoot?: string;
  /** Rerun the doctor and compare its diagnostics with the recorded findings. Default: false. */
  readonly doctor?: boolean;
  /** How to run the doctor; default: a local doctor checkout, else `mizzen` on the PATH. */
  readonly doctorCommand?: DoctorCommand;
  /** Environment for the doctor process. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/** What a recorded file looks like now, compared with the proof's `after` hash. */
export type VerifyProofFileState = "changed" | "missing" | "extra";

/** Why a recorded span did not verify. */
export type VerifyProofSpanState = "moved" | "hash" | "range";

/** How the doctor part of the check ended. */
export type VerifyProofDoctorState =
  | "not-recorded"
  | "not-run"
  | "matched"
  | "mismatched"
  | "unsupported"
  | "unavailable";

/** Why a proof did not match: one failure per claim that did not verify. */
export type VerifyProofFailure =
  | { readonly kind: "proof"; readonly message: string }
  | { readonly kind: "file"; readonly path: string; readonly state: VerifyProofFileState }
  | {
      readonly kind: "span";
      readonly path: string;
      readonly state: VerifyProofSpanState;
      readonly span: ProofSpan;
      /** Where a moved span's text was found. */
      readonly found?: { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number };
    }
  | { readonly kind: "escape"; readonly path: string }
  | { readonly kind: "doctor"; readonly recorded: number; readonly actual: number; readonly difference: string }
  | {
      readonly kind: "doctor-unavailable";
      readonly message: string;
      /** `unsupported` when the proof has no comparable evidence; `unavailable` when the doctor could not run. */
      readonly reason: "unsupported" | "unavailable";
    };

/** What {@link verifyProof} found. */
export interface VerifyProofResult {
  /** True when every recorded file, span, and (when it ran) the doctor evidence matches. */
  readonly ok: boolean;
  /** The proof that was checked, as an absolute path. */
  readonly proof: string;
  /** The folder the record's paths were resolved against, as an absolute path. */
  readonly siteRoot: string;
  /** How many files the record names. */
  readonly files: number;
  /** How the doctor check ended. */
  readonly doctor: VerifyProofDoctorState;
  /** Every mismatch, in path order, with the doctor check last. */
  readonly failures: readonly VerifyProofFailure[];
  /** The first mismatch, absent when `ok` is true. Kept so a caller that reports one failure still can. */
  readonly failure?: VerifyProofFailure;
}

/** A local doctor checkout beside this package, when there is one. */
const SIBLING_DOCTOR = fileURLToPath(new URL("../../../doctor/bin/mizzen.ts", import.meta.url));

/** Why the proof could not be read, as one phrase. */
function readReason(err: unknown): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "it does not exist";
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The default doctor command: a local doctor checkout when it exists, else the installed `mizzen`. */
function defaultDoctorCommand(): DoctorCommand {
  if (existsSync(SIBLING_DOCTOR)) return { command: process.execPath, prefix: [SIBLING_DOCTOR] };
  return { command: "mizzen" };
}

/** Runs `mizzen doctor <siteRoot> --format json` and reads its diagnostics, without importing the doctor package. */
function runDoctor(
  siteRoot: string,
  command: DoctorCommand,
  env: NodeJS.ProcessEnv,
): { readonly findings: ReturnType<typeof parseDoctorReport> } | { readonly error: string } {
  const result = spawnSync(command.command, [...(command.prefix ?? []), "doctor", siteRoot, "--format", "json"], {
    cwd: siteRoot,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) return { error: result.error.message };
  if (result.status !== 0 && result.status !== 1) {
    return { error: `it exited ${result.status === null ? "on a signal" : result.status}` };
  }
  try {
    return { findings: parseDoctorReport(result.stdout) };
  } catch (err) {
    if (err instanceof DoctorReportError) return { error: err.message };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The verification failure one recorded-file issue stands for. */
function failureOf(issue: ProofVerifyIssue): VerifyProofFailure {
  if (issue.code === "verify.path.escape") return { kind: "escape", path: issue.path };
  if (issue.code === "verify.file.changed") return { kind: "file", path: issue.path, state: "changed" };
  if (issue.code === "verify.file.missing") return { kind: "file", path: issue.path, state: "missing" };
  if (issue.code === "verify.file.extra") return { kind: "file", path: issue.path, state: "extra" };
  const state: VerifyProofSpanState =
    issue.code === "verify.span.moved" ? "moved" : issue.code === "verify.span.hash" ? "hash" : "range";
  const span: ProofSpan = {
    line: issue.line ?? 1,
    column: issue.column ?? 1,
    endLine: issue.endLine ?? 1,
    endColumn: issue.endColumn ?? 1,
    hash: issue.hash ?? "",
  };
  return issue.foundLine === undefined
    ? { kind: "span", path: issue.path, state, span }
    : {
        kind: "span",
        path: issue.path,
        state,
        span,
        found: {
          line: issue.foundLine,
          column: issue.foundColumn ?? 1,
          endLine: issue.foundEndLine ?? issue.foundLine,
          endColumn: issue.foundEndColumn ?? 1,
        },
      };
}

/**
 * Checks `options.proof` against the working tree under the site root.
 *
 * Every recorded file is checked in path order: its real path must stay inside the site root, its after hash must
 * match, and every recorded span must cover text that hashes as recorded. A file whose after hash differs has its
 * spans skipped, because they point into text that is gone. When the files and spans all match and `--doctor` was
 * passed, the doctor runs and its diagnostics are compared with the recorded findings; missing, legacy, or
 * unreadable doctor evidence is a failure, never a match. The doctor command never fails the caller by throwing.
 */
export async function verifyProof(options: VerifyProofOptions): Promise<VerifyProofResult> {
  const proof = resolve(options.proof);
  const siteRoot = resolve(options.siteRoot ?? ".");
  const base = { proof, siteRoot } as const;

  let parsed: ParsedProof;
  try {
    parsed = parseProof(await readFile(proof, "utf8"));
  } catch (err) {
    const failure: VerifyProofFailure = { kind: "proof", message: readReason(err) };
    return { ...base, ok: false, files: 0, doctor: "not-recorded", failures: [failure], failure };
  }

  const checked = await verifyProofFiles(siteRoot, parsed.files);
  const failures = checked.flatMap((file) => file.issues.map(failureOf));
  const doctor: VerifyProofDoctorState = parsed.doctor === undefined ? "not-recorded" : "not-run";

  if (failures.length > 0) {
    return { ...base, ok: false, files: checked.length, doctor, failures, failure: failures[0]! };
  }
  if (options.doctor !== true) {
    return { ...base, ok: true, files: checked.length, doctor, failures: [] };
  }

  if (parsed.doctor === undefined) {
    const failure: VerifyProofFailure = {
      kind: "doctor-unavailable",
      reason: "unsupported",
      message: "the proof records no doctor evidence to compare",
    };
    return { ...base, ok: false, files: checked.length, doctor: "unsupported", failures: [failure], failure };
  }
  if (parsed.doctor.findings === undefined) {
    const failure: VerifyProofFailure = {
      kind: "doctor-unavailable",
      reason: "unsupported",
      message: "the proof records only a doctor level, which the current diagnostics JSON cannot verify",
    };
    return { ...base, ok: false, files: checked.length, doctor: "unsupported", failures: [failure], failure };
  }

  const ran = runDoctor(siteRoot, options.doctorCommand ?? defaultDoctorCommand(), options.env ?? process.env);
  if ("error" in ran) {
    const failure: VerifyProofFailure = { kind: "doctor-unavailable", reason: "unavailable", message: ran.error };
    return { ...base, ok: false, files: checked.length, doctor: "unavailable", failures: [failure], failure };
  }

  const compared = compareDoctorFindings(parsed.doctor.findings, ran.findings);
  if (!compared.matched) {
    const failure: VerifyProofFailure = {
      kind: "doctor",
      recorded: compared.recorded,
      actual: compared.actual,
      difference: compared.difference ?? "its findings differ",
    };
    return { ...base, ok: false, files: checked.length, doctor: "mismatched", failures: [failure], failure };
  }
  return { ...base, ok: true, files: checked.length, doctor: "matched", failures: [] };
}

/** One sentence a person can act on for one failed claim. */
function failureMessage(failure: VerifyProofFailure, proof: string): string {
  if (failure.kind === "proof") return `"${proof}" is not a valid proof: ${failure.message}.`;
  if (failure.kind === "file") {
    if (failure.state === "changed") return `"${failure.path}" changed after the proof.`;
    if (failure.state === "missing") return `"${failure.path}" is missing: the proof records it after the edit.`;
    return `"${failure.path}" is extra: the proof records it absent after the edit.`;
  }
  if (failure.kind === "escape") return `"${failure.path}" resolves outside the site root.`;
  if (failure.kind === "span") {
    const where = `"${failure.path}" span ${formatPatchSpan(failure.span)}`;
    if (failure.state === "moved") {
      const found = failure.found === undefined ? "another position" : formatPatchSpan(failure.found);
      return `${where} moved: its text is now at ${found}.`;
    }
    if (failure.state === "range") return `${where} is outside the file.`;
    return `${where} does not match its recorded hash.`;
  }
  if (failure.kind === "doctor") {
    return `the doctor findings do not match the proof: ${failure.difference}.`;
  }
  return `could not verify the doctor: ${failure.message}.`;
}

/** One sentence a person can act on: every claim that did not match, or that the proof holds. */
export function verifyProofMessage(result: VerifyProofResult): string {
  if (result.failures.length > 0) {
    return result.failures.map((failure) => failureMessage(failure, result.proof)).join(" ");
  }

  const count = `${result.files} ${result.files === 1 ? "file" : "files"}`;
  const verb = result.files === 1 ? "matches" : "match";
  if (result.doctor === "matched") return `ok: ${count} ${verb} the proof; the doctor findings match.`;
  if (result.doctor === "not-run") {
    return `ok: ${count} ${verb} the proof. The doctor check was not run; pass --doctor to rerun it.`;
  }
  return `ok: ${count} ${verb} the proof. The proof records no doctor level.`;
}

/** The check that failed: the proof file, a file's hash, a recorded span, a real path, or the doctor evidence. */
export type VerifyCheck = "proof" | "hash" | "span" | "path" | "doctor";

/** One reason a proof did not verify: the failed check, its location, and any span it named. */
export interface VerifyDiagnostic {
  readonly code:
    | "verify.proof-invalid"
    | "verify.file.changed"
    | "verify.file.missing"
    | "verify.file.extra"
    | "verify.path.escape"
    | "verify.span.moved"
    | "verify.span.hash"
    | "verify.span.range"
    | "verify.doctor.mismatch"
    | "verify.doctor.unsupported"
    | "verify.doctor.unavailable";
  readonly check: VerifyCheck;
  /** The failure sentence, the same one the text mode prints. */
  readonly message: string;
  /** The proof for a proof failure, else the site-relative file; null for a doctor failure. */
  readonly path: string | null;
  /** The recorded span, for a span failure. */
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  /** The recorded doctor level for a mismatch, else null. */
  readonly expected: ProofLevel;
  /** The level the doctor reported for a mismatch, else null. */
  readonly actual: ProofLevel;
}

/** The JSON `mizzen edit verify --format json` prints: one shape for a match and every failure. */
export interface VerifyProofReport {
  readonly version: 1;
  readonly command: "edit.verify";
  /** `ok` is exit 0, `failed` exit 1, `invalid` exit 2. */
  readonly status: "ok" | "failed" | "invalid";
  readonly ok: boolean;
  /** The code the command returns; `status` names it. */
  readonly exitCode: number;
  readonly proof: string;
  readonly siteRoot: string;
  readonly files: number;
  readonly doctor: VerifyProofDoctorState;
  readonly diagnostics: readonly VerifyDiagnostic[];
}

/** The file-state failure codes, one per {@link VerifyProofFileState}. */
const FILE_CODE: Record<VerifyProofFileState, "verify.file.changed" | "verify.file.missing" | "verify.file.extra"> = {
  changed: "verify.file.changed",
  missing: "verify.file.missing",
  extra: "verify.file.extra",
};

/** The span-state failure codes, one per {@link VerifyProofSpanState}. */
const SPAN_CODE: Record<VerifyProofSpanState, "verify.span.moved" | "verify.span.hash" | "verify.span.range"> = {
  moved: "verify.span.moved",
  hash: "verify.span.hash",
  range: "verify.span.range",
};

/** The failed check as data, with the sentence the text mode prints. */
function diagnosticOf(failure: VerifyProofFailure, result: VerifyProofResult): VerifyDiagnostic {
  const message = failureMessage(failure, result.proof);
  const base = { message, expected: null, actual: null } as const;
  if (failure.kind === "proof") {
    return { code: "verify.proof-invalid", check: "proof", path: result.proof, ...base };
  }
  if (failure.kind === "file") {
    return { code: FILE_CODE[failure.state], check: "hash", path: failure.path, ...base };
  }
  if (failure.kind === "escape") {
    return { code: "verify.path.escape", check: "path", path: failure.path, ...base };
  }
  if (failure.kind === "span") {
    return {
      code: SPAN_CODE[failure.state],
      check: "span",
      path: failure.path,
      line: failure.span.line,
      column: failure.span.column,
      endLine: failure.span.endLine,
      endColumn: failure.span.endColumn,
      ...base,
    };
  }
  if (failure.kind === "doctor") {
    return { code: "verify.doctor.mismatch", check: "doctor", path: null, ...base };
  }
  return {
    code: failure.reason === "unsupported" ? "verify.doctor.unsupported" : "verify.doctor.unavailable",
    check: "doctor",
    path: null,
    ...base,
  };
}

/**
 * The machine-readable result of `edit verify`. `exitCode` is the code the command returns, so the
 * report and the exit status always agree; every failure names the check that failed and where it is.
 */
export function formatVerifyProofJson(result: VerifyProofResult, exitCode: number): string {
  const report: VerifyProofReport = {
    version: 1,
    command: "edit.verify",
    status: exitCode === 0 ? "ok" : exitCode === 2 ? "invalid" : "failed",
    ok: exitCode === 0,
    exitCode,
    proof: result.proof,
    siteRoot: result.siteRoot,
    files: result.files,
    doctor: result.doctor,
    diagnostics: result.failures.map((failure) => diagnosticOf(failure, result)),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
