/**
 * `mizzen verify <dir> [--hash <hex>]`: check a built folder against the hash its manifest recorded (#1252).
 *
 * The expected hash comes from `--hash` when given, otherwise from `build.hash` in `<dir>/.mizzen/manifest.json`.
 * The folder is hashed by the same rule the build used, and, when the manifest carries the per-file record, the first
 * file that changed, went missing, or was added is named. Exit 0 is a match and 1 is a mismatch; a usage error is 2.
 *
 * A manifest is trusted only when every recorded path is one an identity can name, every recorded value is a SHA-256,
 * and its whole-build hash matches its own file map. A malformed manifest is reported as malformed even when
 * `--hash` supplies an expected hash: the on-disk record cannot be made trusted by the caller. Symlinks and special
 * entries in the folder are reported as unsupported, never skipped, and links are not followed.
 *
 */
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildHashOf,
  byCodePoint,
  fingerprint,
  isIdentityFile,
  MANIFEST_PATH,
  type BuildRecord,
  UnsupportedEntryError,
  type UnsupportedEntry,
} from "../outputs/build-hash.ts";

/** Options of {@link verify}. */
export interface VerifyOptions {
  /** The built folder to check. */
  readonly dir: string;
  /** Expected build hash; defaults to the one in the folder's manifest. */
  readonly hash?: string;
}

/** Why a folder does not match its build. */
export type VerifyFailure =
  | { readonly kind: "folder"; readonly dir: string }
  | { readonly kind: "manifest"; readonly dir: string }
  | { readonly kind: "record"; readonly dir: string }
  | { readonly kind: "malformed"; readonly dir: string; readonly reason: string }
  | { readonly kind: "unsupported"; readonly path: string; readonly entry: UnsupportedEntry }
  | { readonly kind: "file"; readonly path: string; readonly state: "changed" | "missing" | "extra" }
  | { readonly kind: "hash"; readonly expected: string; readonly actual: string };

/** What {@link verify} found. */
export interface VerifyResult {
  /** True when every file and the whole-build hash match. */
  readonly ok: boolean;
  /** The folder that was checked. */
  readonly dir: string;
  /** The hash computed from the folder. */
  readonly actual: string;
  /** The hash the folder was checked against, when one was found. */
  readonly expected?: string;
  /** How many files were hashed. */
  readonly files: number;
  /** The first mismatch, absent when `ok` is true. */
  readonly failure?: VerifyFailure;
}

/** What the manifest in the checked folder says, if anything. */
type ManifestState =
  | { readonly kind: "absent" }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "valid"; readonly record: BuildRecord }
  | { readonly kind: "malformed"; readonly reason: string };

/** SHA-256 as the build writes it: 64 lowercase hex characters. */
const HASH = /^[0-9a-f]{64}$/;

/** A manifest that cannot be trusted, with one deterministic reason. */
function malformed(reason: string): ManifestState {
  return { kind: "malformed", reason };
}

/**
 * Checks a manifest's `build` field: shape, every path, every hash, and the whole-build hash against its own map.
 * Keys are visited in code-point order, so the reported reason does not depend on the order they were written in.
 */
function checkRecord(value: unknown): ManifestState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("build is not an object");
  const { hash, files } = value as { hash?: unknown; files?: unknown };
  if (typeof hash !== "string" || !HASH.test(hash)) return malformed("build.hash is not a lowercase SHA-256");
  if (typeof files !== "object" || files === null || Array.isArray(files)) return malformed("build.files is not an object");

  // A null prototype keeps a path literally named `__proto__` an ordinary key, as it is in the record.
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of Object.keys(files).sort(byCodePoint)) {
    const file = (files as Record<string, unknown>)[path];
    if (!isIdentityFile(path)) return malformed(`build.files has an unsafe path ${JSON.stringify(path)}`);
    if (typeof file !== "string" || !HASH.test(file)) {
      return malformed(`build.files[${JSON.stringify(path)}] is not a lowercase SHA-256`);
    }
    record[path] = file;
  }
  if (buildHashOf(record) !== hash) return malformed("build.hash does not match build.files");
  return { kind: "valid", record: { hash, files: record } };
}

/** A manifest read that keeps "absent" apart from a file whose content cannot be read as a regular file. */
type ManifestText =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "text"; readonly text: string };

/** Reads the manifest without following a final symlink, so verification stays inside the checked folder. */
async function readManifestText(dir: string): Promise<ManifestText> {
  try {
    const info = await lstat(join(dir, ".mizzen"));
    if (info.isSymbolicLink()) return { kind: "malformed", reason: "the manifest directory is a symlink" };
    if (!info.isDirectory()) return { kind: "absent" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let handle: FileHandle;
  try {
    handle = await open(join(dir, MANIFEST_PATH), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    if (code === "ELOOP" || code === "EISDIR") return { kind: "malformed", reason: "not a regular file" };
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "malformed", reason: "not a regular file" };
    return { kind: "text", text: await handle.readFile({ encoding: "utf8" }) };
  } finally {
    await handle.close();
  }
}

/** Reads and validates `<dir>/.mizzen/manifest.json`. */
async function readManifest(dir: string): Promise<ManifestState> {
  const read = await readManifestText(dir);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "malformed") return malformed(read.reason);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return malformed("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return malformed("not a JSON object");
  const build = (parsed as { build?: unknown }).build;
  if (build === undefined) return { kind: "unrecorded" };
  return checkRecord(build);
}

/** The first file that differs between the recorded build and the folder, in path order. */
function firstDifference(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): { readonly path: string; readonly state: "changed" | "missing" | "extra" } | undefined {
  const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(byCodePoint);
  for (const path of paths) {
    const want = expected[path];
    const got = actual[path];
    if (want === undefined) return { path, state: "extra" };
    if (got === undefined) return { path, state: "missing" };
    if (want !== got) return { path, state: "changed" };
  }
  return undefined;
}

/** One sentence a person can act on: what did not match, or the hash that did. */
export function verifyMessage(result: VerifyResult): string {
  const failure = result.failure;
  if (failure === undefined) return `ok: ${result.actual}`;
  if (failure.kind === "folder") return `"${failure.dir}" is not a folder.`;
  if (failure.kind === "manifest") {
    return `"${join(failure.dir, MANIFEST_PATH)}" is missing or not a valid manifest; build the site first, or pass --hash.`;
  }
  if (failure.kind === "record") return `the manifest in "${failure.dir}" has no build hash; rebuild the site, or pass --hash.`;
  if (failure.kind === "malformed") {
    return `the manifest in "${failure.dir}" is malformed: ${failure.reason}; rebuild the site.`;
  }
  if (failure.kind === "unsupported") {
    return failure.entry === "path"
      ? `"${failure.path}" is not a path a build identity can name.`
      : `"${failure.path}" is a ${failure.entry} entry; a build identity hashes regular files only.`;
  }
  if (failure.kind === "file") {
    if (failure.state === "changed") return `"${failure.path}" differs from the build.`;
    if (failure.state === "missing") return `"${failure.path}" is missing from the folder.`;
    return `"${failure.path}" is not part of the build.`;
  }
  return `the folder hashes to ${failure.actual}, not ${failure.expected}.`;
}

/** Checks `options.dir` against its recorded build hash (or `options.hash`). */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const dir = resolve(options.dir);
  const missing = (failure: VerifyFailure): VerifyResult => ({ ok: false, dir, actual: "", files: 0, failure });

  const manifest = await readManifest(dir);

  let actual: BuildRecord;
  try {
    actual = await fingerprint(dir);
  } catch (err) {
    if (err instanceof UnsupportedEntryError) {
      return missing({ kind: "unsupported", path: err.path, entry: err.entry });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return missing({ kind: "folder", dir });
    }
    throw err;
  }
  const files = Object.keys(actual.files).length;

  // The record cannot be trusted even with --hash: the caller can supply a hash, not repair the manifest.
  if (manifest.kind === "malformed") {
    return { ok: false, dir, actual: actual.hash, files, failure: { kind: "malformed", dir, reason: manifest.reason } };
  }
  const record = manifest.kind === "valid" ? manifest.record : undefined;
  const expected = options.hash ?? record?.hash;

  if (expected === undefined) {
    return {
      ok: false,
      dir,
      actual: actual.hash,
      files,
      failure: manifest.kind === "unrecorded" ? { kind: "record", dir } : { kind: "manifest", dir },
    };
  }

  if (record !== undefined) {
    const difference = firstDifference(record.files, actual.files);
    if (difference !== undefined) {
      return { ok: false, dir, actual: actual.hash, expected, files, failure: { kind: "file", ...difference } };
    }
  }
  if (actual.hash !== expected) {
    return {
      ok: false,
      dir,
      actual: actual.hash,
      expected,
      files,
      failure: { kind: "hash", expected, actual: actual.hash },
    };
  }
  return { ok: true, dir, actual: actual.hash, expected, files };
}
