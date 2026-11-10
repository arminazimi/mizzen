/**
 * `mizzen edit verify <proof.json> [--site <dir>] [--doctor]`: check a proof record against the working tree (#1512).
 *
 * The proof record ([N29](../edits/proof.ts)) keeps the SHA-256 of every touched file after the edit. This command
 * re-hashes the files it names under the site root and stops at the first one that changed, went missing, or came
 * back after the proof recorded it as deleted, so an edit an agent reports is checked against what is on disk.
 *
 * The doctor is a separate package, so it runs as a command and never as an import: `mizzen doctor <dir> --format
 * json`, whose `level` is compared with the one the proof recorded. Without `--doctor` the hashes are still checked
 * and the command says that the doctor check did not run. A matching proof exits 0, a mismatching file or doctor
 * level exits 1, and a proof that cannot be read is a usage error and exits 2.
 *
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROOF_LEVELS, PROOF_VERSION, type ProofLevel } from "../edits/proof.ts";

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
  /** Rerun the doctor and compare its level with the recorded one. Default: false. */
  readonly doctor?: boolean;
  /** How to run the doctor; default: the sibling doctor package, else `mizzen` on the PATH. */
  readonly doctorCommand?: DoctorCommand;
  /** Environment for the doctor process. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/** What a recorded file looks like now, compared with the proof's `after` hash. */
export type VerifyProofFileState = "changed" | "missing" | "extra";

/** How the doctor part of the check ended. */
export type VerifyProofDoctorState =
  | "not-recorded"
  | "not-run"
  | "matched"
  | "mismatched"
  | "unavailable";

/** Why a proof did not match the working tree. */
export type VerifyProofFailure =
  | { readonly kind: "proof"; readonly message: string }
  | { readonly kind: "file"; readonly path: string; readonly state: VerifyProofFileState }
  | { readonly kind: "doctor"; readonly expected: ProofLevel; readonly actual: ProofLevel }
  | { readonly kind: "doctor-unavailable"; readonly message: string };

/** What {@link verifyProof} found. */
export interface VerifyProofResult {
  /** True when every recorded file still hashes to its `after` value, and the doctor matches when it ran. */
  readonly ok: boolean;
  /** The proof that was checked, as an absolute path. */
  readonly proof: string;
  /** The folder the record's paths were resolved against, as an absolute path. */
  readonly siteRoot: string;
  /** How many files the record names. */
  readonly files: number;
  /** How the doctor check ended. */
  readonly doctor: VerifyProofDoctorState;
  /** The first mismatch, absent when `ok` is true. */
  readonly failure?: VerifyProofFailure;
}

/** One file entry, kept to the fields a check needs. */
interface ProofFileEntry {
  readonly path: string;
  readonly after: string | null;
}

/** The parts of a record {@link verifyProof} uses. `doctor` is absent when the record has no doctor result. */
interface ParsedProof {
  readonly files: readonly ProofFileEntry[];
  readonly doctor?: { readonly level: ProofLevel };
}

/** A proof that cannot be read or does not have the shape the format requires. */
class ProofReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofReadError";
  }
}

/** The doctor entry point beside this package in the monorepo, when it is there. */
const SIBLING_DOCTOR = fileURLToPath(new URL("../../../doctor/bin/mizzen.ts", import.meta.url));

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A hash the record may keep: 64 lowercase hex characters, or `null` for a file absent on that side. */
function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function isLevel(value: unknown): value is ProofLevel {
  return value === null || (typeof value === "string" && (PROOF_LEVELS as readonly string[]).includes(value));
}

/** A path that stays inside the site root and uses forward slashes, as the proof schema requires. */
function isProofPath(path: string): boolean {
  if (path === "" || path === "." || path === ".." || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

/** Parses the record, refusing anything that is not one complete proof of the current version. */
function parseProof(text: string): ParsedProof {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProofReadError("it is not JSON");
  }
  if (!isObject(value)) throw new ProofReadError("it is not a JSON object");
  if (value.version !== PROOF_VERSION) {
    throw new ProofReadError(`its version is ${String(value.version)}, not ${PROOF_VERSION}`);
  }
  if (!Array.isArray(value.files)) throw new ProofReadError("`files` is not a list");

  const files: ProofFileEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!isObject(entry)) throw new ProofReadError("a `files` entry is not an object");
    const path = entry.path;
    if (typeof path !== "string" || !isProofPath(path)) {
      throw new ProofReadError(`"${String(path)}" is not a path inside the site root`);
    }
    if (seen.has(path)) throw new ProofReadError(`"${path}" is listed more than once`);
    if (!isHashOrNull(entry.before) || !isHashOrNull(entry.after)) {
      throw new ProofReadError(`"${path}" does not have a before and an after hash`);
    }
    seen.add(path);
    files.push({ path, after: entry.after });
  }

  if (value.doctor === undefined) return { files };
  if (!isObject(value.doctor)) throw new ProofReadError("`doctor` is not an object");
  if (!isLevel(value.doctor.level)) {
    throw new ProofReadError(`the doctor level ${String(value.doctor.level)} is not one of L0, L1, L2, L3, or null`);
  }
  return { files, doctor: { level: value.doctor.level } };
}

/** Why the proof could not be read, as one phrase. */
function readReason(err: unknown): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "it does not exist";
  if (err instanceof Error) return err.message;
  return String(err);
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolves a record path under the site root, with forward slashes split for the platform. */
function fileAt(siteRoot: string, path: string): string {
  return join(siteRoot, ...path.split("/"));
}

/** Compares one recorded file with the working tree. */
async function fileState(siteRoot: string, entry: ProofFileEntry): Promise<VerifyProofFileState | "ok"> {
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(fileAt(siteRoot, entry.path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return entry.after === null ? "extra" : "changed";
  }

  if (entry.after === null) return bytes === undefined ? "ok" : "extra";
  if (bytes === undefined) return "missing";
  return hashBytes(bytes) === entry.after ? "ok" : "changed";
}

/** The default doctor command: the sibling package when it exists, else the installed `mizzen`. */
function defaultDoctorCommand(): DoctorCommand {
  if (existsSync(SIBLING_DOCTOR)) return { command: process.execPath, prefix: [SIBLING_DOCTOR] };
  return { command: "mizzen" };
}

/** Runs `mizzen doctor <siteRoot> --format json` and reads its level, without importing the doctor package. */
function runDoctor(
  siteRoot: string,
  command: DoctorCommand,
  env: NodeJS.ProcessEnv,
): { readonly level: ProofLevel } | { readonly error: string } {
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

  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { error: "its output is not JSON" };
  }
  if (!isObject(report) || !isLevel(report.level)) {
    return { error: "its report does not have a doctor level" };
  }
  return { level: report.level };
}

/**
 * Checks `options.proof` against the working tree under the site root.
 *
 * Every recorded file is compared with its after-edit hash in path order, and the first difference is returned. Only
 * when every file matches does `--doctor` rerun the doctor; a level it cannot compare is still a failure, and the
 * doctor command never fails the caller by throwing.
 */
export async function verifyProof(options: VerifyProofOptions): Promise<VerifyProofResult> {
  const proof = resolve(options.proof);
  const siteRoot = resolve(options.siteRoot ?? ".");
  const base = { proof, siteRoot } as const;

  let parsed: ParsedProof;
  try {
    parsed = parseProof(await readFile(proof, "utf8"));
  } catch (err) {
    return {
      ...base,
      ok: false,
      files: 0,
      doctor: "not-recorded",
      failure: { kind: "proof", message: readReason(err) },
    };
  }

  const files = [...parsed.files].sort((a, b) => byCodePoint(a.path, b.path));
  const doctor: VerifyProofDoctorState = parsed.doctor === undefined ? "not-recorded" : "not-run";
  for (const entry of files) {
    const state = await fileState(siteRoot, entry);
    if (state !== "ok") {
      return { ...base, ok: false, files: files.length, doctor, failure: { kind: "file", path: entry.path, state } };
    }
  }

  if (parsed.doctor === undefined || options.doctor !== true) {
    return { ...base, ok: true, files: files.length, doctor };
  }

  const ran = runDoctor(siteRoot, options.doctorCommand ?? defaultDoctorCommand(), options.env ?? process.env);
  if ("error" in ran) {
    return {
      ...base,
      ok: false,
      files: files.length,
      doctor: "unavailable",
      failure: { kind: "doctor-unavailable", message: ran.error },
    };
  }
  if (ran.level !== parsed.doctor.level) {
    return {
      ...base,
      ok: false,
      files: files.length,
      doctor: "mismatched",
      failure: { kind: "doctor", expected: parsed.doctor.level, actual: ran.level },
    };
  }
  return { ...base, ok: true, files: files.length, doctor: "matched" };
}

/** One sentence a person can act on: what did not match, or that the proof holds. */
export function verifyProofMessage(result: VerifyProofResult): string {
  const failure = result.failure;
  if (failure !== undefined) {
    if (failure.kind === "proof") return `"${result.proof}" is not a valid proof: ${failure.message}.`;
    if (failure.kind === "file") {
      if (failure.state === "changed") return `"${failure.path}" changed after the proof.`;
      if (failure.state === "missing") return `"${failure.path}" is missing: the proof records it after the edit.`;
      return `"${failure.path}" is extra: the proof records it absent after the edit.`;
    }
    if (failure.kind === "doctor") {
      return `the doctor level is ${failure.actual ?? "none"}, not the recorded ${failure.expected ?? "none"}.`;
    }
    return `could not run the doctor: ${failure.message}.`;
  }

  const count = `${result.files} ${result.files === 1 ? "file" : "files"}`;
  const verb = result.files === 1 ? "matches" : "match";
  if (result.doctor === "matched") return `ok: ${count} ${verb} the proof; the doctor level matches.`;
  if (result.doctor === "not-run") {
    return `ok: ${count} ${verb} the proof. The doctor check was not run; pass --doctor to rerun it.`;
  }
  return `ok: ${count} ${verb} the proof. The proof records no doctor level.`;
}
