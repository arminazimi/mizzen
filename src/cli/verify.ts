/**
 * `mizzen verify <dir> [--hash <hex>]`: check a built folder against the hash its manifest recorded (#1252).
 *
 * The expected hash comes from `--hash` when given, otherwise from `build.hash` in `<dir>/.mizzen/manifest.json`.
 * The folder is hashed by the same rule the build used, and, when the manifest carries the per-file record, the first
 * file that changed, went missing, or was added is named. Exit 0 is a match and 1 is a mismatch; a usage error is 2.
 *
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { byCodePoint, fingerprint, MANIFEST_PATH, type BuildRecord } from "../outputs/build-hash.ts";

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

/** A manifest's `build` field, when it has the shape the build writes. */
function isRecord(value: unknown): value is BuildRecord {
  if (typeof value !== "object" || value === null) return false;
  const { hash, files } = value as { hash?: unknown; files?: unknown };
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
  if (typeof files !== "object" || files === null) return false;
  return Object.values(files).every((file) => typeof file === "string" && /^[0-9a-f]{64}$/.test(file));
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

  let record: BuildRecord | undefined;
  let hasManifest = false;
  let brokenManifest = false;
  try {
    const text = await readFile(join(dir, MANIFEST_PATH), "utf8");
    hasManifest = true;
    try {
      const parsed = JSON.parse(text) as { build?: unknown };
      if (isRecord(parsed.build)) record = parsed.build;
    } catch {
      brokenManifest = true;
    }
  } catch (err) {
    // A folder without a manifest is only an error when there is no --hash; the hash still has to be computed.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let actual: BuildRecord;
  try {
    actual = await fingerprint(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return missing({ kind: "folder", dir });
    }
    throw err;
  }
  const files = Object.keys(actual.files).length;
  const expected = options.hash ?? record?.hash;

  if (brokenManifest) return { ok: false, dir, actual: actual.hash, files, failure: { kind: "manifest", dir } };
  if (expected === undefined) {
    return {
      ok: false,
      dir,
      actual: actual.hash,
      files,
      failure: hasManifest ? { kind: "record", dir } : { kind: "manifest", dir },
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
