/**
 * `mizzen edit apply <patch.json> [dir] [--dry-run] [--proof <path>]`: apply one agent patch and
 * write its proof (#1510, N30).
 *
 * The patch is the plain-data shape of N27 (`src/edits/patch.ts`): one span with 1-based lines and
 * columns, the optional text it expected to find there, its replacement, and the optional SHA-256
 * of the source it was computed from. The source is `span.file`, resolved against the site root and
 * refused when it points outside it. The patch is applied in memory first; the file is written only
 * when the whole patch succeeds, through a temporary file beside it and one rename, so a refusal
 * leaves it byte-identical.
 *
 * After a successful write the command records an N29 proof (`src/edits/proof.ts`) with the SHA-256
 * of the file before and after, at `--proof` or `<patch>.proof.json`. A dry run prints the unified
 * diff and writes neither the source nor the proof.
 *
 * Exit codes follow the rest of the CLI: `0` applied (or a dry run that would apply), `1` a refused
 * patch or a refused path (the file is unchanged), `2` a usage problem, such as a patch that is
 * missing or is not a patch. `--format json` prints the same outcome as one {@link EditApplyReport}.
 *
 */
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyPatch, hashSource, PatchError, type Patch, type PatchSpan } from "../edits/patch.ts";
import { writeProof } from "../edits/proof.ts";

/** Options of {@link editApply}. */
export interface EditApplyOptions {
  /** The site root the patch's `span.file` is resolved against, and the base of the proof's paths. */
  readonly siteRoot: string;
  /** The patch JSON file, resolved from the current directory like `--out`. */
  readonly patch: string;
  /** The proof record's path; defaults to `<patch>.proof.json`. */
  readonly proof?: string;
  /** Print the diff and write neither the source nor the proof. */
  readonly dryRun?: boolean;
}

/** What a successful {@link editApply} did, or what a dry run would do. */
export interface EditApplyResult {
  /** True when nothing was written. */
  readonly dryRun: boolean;
  /** The site root, absolute. */
  readonly siteRoot: string;
  /** The edited file, relative to the site root, with forward slashes. */
  readonly file: string;
  /** The proof record's absolute path; absent for a dry run. */
  readonly proof?: string;
  /** The unified diff; present for a dry run only. */
  readonly diff?: string;
  /** SHA-256 of the source before the patch. */
  readonly beforeHash: string;
  /** SHA-256 of the source after the patch. */
  readonly afterHash: string;
}

/** Why {@link editApply} refused. Each code names one situation, so the CLI can pick an exit code. */
export type EditApplyErrorCode =
  | "edit.patch-missing"
  | "edit.patch-invalid"
  | "edit.path-escape"
  | "edit.source-missing"
  | "edit.patch-refused"
  | "edit.write-failed";

/** A refused application. `usage` is true when the request itself is malformed (exit 2). */
export class EditApplyError extends Error {
  readonly code: EditApplyErrorCode;
  readonly usage: boolean;
  /** The file the refusal names: site-relative for a source file, as given for a patch file. */
  readonly path: string | undefined;
  /** The patch span the refusal names, when it has one. */
  readonly span: PatchSpan | undefined;

  constructor(
    code: EditApplyErrorCode,
    message: string,
    usage: boolean,
    details: { readonly path?: string; readonly span?: PatchSpan } = {},
  ) {
    super(message);
    this.name = "EditApplyError";
    this.code = code;
    this.usage = usage;
    this.path = details.path;
    this.span = details.span;
  }
}

/** Whether `value` is a plain object, not an array or null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One positive whole number, as a patch line or column must be. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The span of a parsed patch, refusing a missing or malformed field. */
function spanOf(value: unknown, patch: string): PatchSpan {
  if (!isObject(value)) {
    throw new EditApplyError("edit.patch-invalid", `${patch}: "span" is not an object.`, true);
  }
  for (const key of ["line", "column", "endLine", "endColumn"] as const) {
    if (!positiveInteger(value[key])) {
      throw new EditApplyError(
        "edit.patch-invalid",
        `${patch}: span.${key} is not a 1-based whole number.`,
        true,
      );
    }
  }
  const file = value.file;
  if (file === undefined) {
    throw new EditApplyError(
      "edit.patch-invalid",
      `${patch}: span.file is missing; the file to patch cannot be resolved.`,
      true,
    );
  }
  if (typeof file !== "string" || file === "") {
    throw new EditApplyError("edit.patch-invalid", `${patch}: span.file is not a non-empty string.`, true);
  }
  return {
    file,
    line: value.line as number,
    column: value.column as number,
    endLine: value.endLine as number,
    endColumn: value.endColumn as number,
  };
}

/** A parsed patch: exactly the fields N27 knows, with the optional ones dropped when absent. */
function patchOf(value: unknown, path: string): Patch {
  if (!isObject(value)) {
    throw new EditApplyError("edit.patch-invalid", `${path}: the patch is not a JSON object.`, true);
  }
  if (typeof value.replacement !== "string") {
    throw new EditApplyError("edit.patch-invalid", `${path}: "replacement" is not a string.`, true);
  }
  for (const key of ["expected", "beforeHash"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") {
      throw new EditApplyError("edit.patch-invalid", `${path}: "${key}" is not a string.`, true);
    }
  }
  return {
    span: spanOf(value.span, path),
    replacement: value.replacement,
    ...(value.expected === undefined ? {} : { expected: value.expected as string }),
    ...(value.beforeHash === undefined ? {} : { beforeHash: value.beforeHash as string }),
  };
}

/** The patch file's bytes as a {@link Patch}, refusing a missing file or one that is not a patch. */
async function readPatch(path: string): Promise<Patch> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "it does not exist" : error instanceof Error ? error.message : String(error);
    throw new EditApplyError("edit.patch-missing", `${path}: cannot read the patch: ${reason}.`, true, { path });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EditApplyError("edit.patch-invalid", `${path}: the patch is not JSON: ${reason}.`, true, { path });
  }
  try {
    return patchOf(value, path);
  } catch (error) {
    // A malformed patch names no source file, so the patch itself is the path the report can give.
    if (error instanceof EditApplyError && error.path === undefined) {
      throw new EditApplyError(error.code, error.message, error.usage, { path });
    }
    throw error;
  }
}

/** The target's path inside the site root, refusing a `span.file` that would leave it. */
function insideRoot(
  siteRoot: string,
  file: string,
  span: PatchSpan,
): { readonly path: string; readonly record: string } {
  const root = resolve(siteRoot);
  const path = resolve(root, file);
  const inside = relative(root, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new EditApplyError(
      "edit.path-escape",
      `${file}: the patch's file is outside the site root "${root}"; refusing it.`,
      false,
      { path: file, span },
    );
  }
  return { path, record: inside.split(sep).join("/") };
}

/** The lines of a text, without a trailing newline's empty final line. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A unified diff of `before` and `after` for `file`, with three lines of context. A patch replaces
 * one span, so its change is one contiguous run; a shared prefix and suffix are cut away instead of
 * running a full diff, which keeps the output deterministic and small.
 */
export function unifiedDiff(before: string, after: string, file: string, context = 3): string {
  if (before === after) return "";
  const oldLines = linesOf(before);
  const newLines = linesOf(after);

  let prefix = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldStart = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + context);
  const newStart = Math.max(0, prefix - context);
  const newEnd = Math.min(newLines.length, newChangeEnd + context);

  const body: string[] = [];
  for (let index = oldStart; index < prefix; index += 1) body.push(` ${oldLines[index]}`);
  for (let index = prefix; index < oldChangeEnd; index += 1) body.push(`-${oldLines[index]}`);
  for (let index = prefix; index < newChangeEnd; index += 1) body.push(`+${newLines[index]}`);
  for (let index = oldChangeEnd; index < oldEnd; index += 1) body.push(` ${oldLines[index]}`);

  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;
  const oldFrom = oldCount === 0 ? oldStart : oldStart + 1;
  const newFrom = newCount === 0 ? newStart : newStart + 1;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldFrom},${oldCount} +${newFrom},${newCount} @@`,
    ...body,
    "",
  ].join("\n");
}

/** Writes `text` in one rename: a fresh folder beside the target, one file, then the rename. */
async function writeAtomic(target: string, text: string): Promise<void> {
  const folder = dirname(target);
  const mode = (await stat(target)).mode & 0o7777;
  const staging = await mkdtemp(join(folder, ".edit-apply-"));
  try {
    const temp = join(staging, "source");
    await writeFile(temp, text, "utf8");
    await chmod(temp, mode);
    await rename(temp, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Applies one patch to its source file and (unless `dryRun`) writes both the source and an N29
 * proof record. The patch and the whole new source are computed in memory first: a refusal throws
 * an {@link EditApplyError} before the file is touched.
 */
export async function editApply(options: EditApplyOptions): Promise<EditApplyResult> {
  const siteRoot = resolve(options.siteRoot);
  const patch = await readPatch(options.patch);
  const spanFile = patch.span.file;
  if (spanFile === undefined) {
    throw new EditApplyError("edit.patch-invalid", `${options.patch}: the patch names no file.`, true, {
      path: options.patch,
    });
  }
  const target = insideRoot(siteRoot, spanFile, patch.span);

  let source: string;
  try {
    source = await readFile(target.path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR") throw error;
    throw new EditApplyError(
      "edit.source-missing",
      `${target.record}: the patch's file cannot be read; nothing was written.`,
      false,
      { path: target.record, span: patch.span },
    );
  }

  let after: string;
  try {
    after = applyPatch(source, patch);
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    throw new EditApplyError(
      "edit.patch-refused",
      `${target.record}: the patch was refused and the file is unchanged: ${error.message}`,
      false,
      { path: target.record, span: error.span },
    );
  }

  const beforeHash = hashSource(source);
  const afterHash = hashSource(after);

  if (options.dryRun === true) {
    return {
      dryRun: true,
      siteRoot,
      file: target.record,
      diff: unifiedDiff(source, after, target.record),
      beforeHash,
      afterHash,
    };
  }

  try {
    await writeAtomic(target.path, after);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EditApplyError("edit.write-failed", `${target.record}: writing the file failed: ${reason}.`, false, {
      path: target.record,
    });
  }

  const proof = options.proof === undefined ? `${resolve(options.patch)}.proof.json` : resolve(options.proof);
  try {
    await writeProof({
      siteRoot,
      files: [target.record],
      before: { [target.record]: source },
      after: { [target.record]: after },
      out: proof,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EditApplyError(
      "edit.write-failed",
      `${target.record}: the file was written, but the proof at "${proof}" was not: ${reason}.`,
      false,
      { path: target.record },
    );
  }

  return { dryRun: false, siteRoot, file: target.record, proof, beforeHash, afterHash };
}

/** How a command ended: `ok` is exit 0, `failed` exit 1, `invalid` exit 2. */
export type EditStatus = "ok" | "failed" | "invalid";

/** Why an application did not happen, with the file and span it names when they are known. */
export interface EditApplyDiagnostic {
  /** Stable code, the same one the {@link EditApplyError} carries. */
  readonly code: EditApplyErrorCode;
  /** The refusal sentence, without the `mizzen: ` prefix the text mode adds. */
  readonly message: string;
  /** The file the refusal names: site-relative for a source file, as given for a patch file; null when none. */
  readonly path: string | null;
  /** The patch span, 1-based with an inclusive end; its `file` repeats `path` when there is one. */
  readonly span: PatchSpan | null;
}

/** The JSON `mizzen edit apply --format json` prints: one shape for success, dry run, and refusal. */
export interface EditApplyReport {
  readonly version: 1;
  readonly command: "edit.apply";
  readonly status: EditStatus;
  readonly ok: boolean;
  /** The code the command returns; `status` names it. */
  readonly exitCode: number;
  readonly dryRun: boolean;
  /** True only when the source and its proof were written. */
  readonly applied: boolean;
  readonly siteRoot: string | null;
  /** The edited file, relative to the site root, when the patch named one. */
  readonly file: string | null;
  readonly proof: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  /** The unified diff; a dry run only. */
  readonly diff: string | null;
  readonly diagnostics: readonly EditApplyDiagnostic[];
}

/** The status an exit code names. */
function statusOf(exitCode: number): EditStatus {
  return exitCode === 0 ? "ok" : exitCode === 2 ? "invalid" : "failed";
}

/**
 * The machine-readable result of `edit apply`. `exitCode` is the code the command returns, so the
 * report and the exit status always agree: a dry run that would apply is a success, while a refusal
 * is `failed` (exit 1) or `invalid` (exit 2) and names its file and span.
 */
export function formatEditApplyJson(outcome: EditApplyResult | EditApplyError, exitCode: number): string {
  const report: EditApplyReport =
    outcome instanceof EditApplyError
      ? {
          version: 1,
          command: "edit.apply",
          status: statusOf(exitCode),
          ok: exitCode === 0,
          exitCode,
          dryRun: false,
          applied: false,
          siteRoot: null,
          file: null,
          proof: null,
          beforeHash: null,
          afterHash: null,
          diff: null,
          diagnostics: [
            {
              code: outcome.code,
              message: outcome.message,
              path: outcome.path ?? null,
              span: outcome.span ?? null,
            },
          ],
        }
      : {
          version: 1,
          command: "edit.apply",
          status: statusOf(exitCode),
          ok: exitCode === 0,
          exitCode,
          dryRun: outcome.dryRun,
          applied: !outcome.dryRun,
          siteRoot: outcome.siteRoot,
          file: outcome.file,
          proof: outcome.proof ?? null,
          beforeHash: outcome.beforeHash,
          afterHash: outcome.afterHash,
          diff: outcome.diff ?? null,
          diagnostics: [],
        };
  return `${JSON.stringify(report, null, 2)}\n`;
}
