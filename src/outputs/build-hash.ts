/**
 * One SHA-256 for a whole build, recorded in `.mizzen/manifest.json` and checked by `mizzen verify` (#1252).
 *
 * Every file the build writes, except the manifest that records the result, is hashed; the whole-build hash is the
 * SHA-256 of one line per file (`<path>`, a NUL, the file's hash, and a line feed), with the paths sorted by code
 * point. The build and `verify` run the same rule, so both agree byte for byte.
 *
 * The manifest cannot hash itself, so it is left out: a change to the record is not a change to the build. A site
 * file that replaces the manifest makes the build leave it alone.
 *
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Where the manifest lands, relative to the output folder. The build hash leaves it out. */
export const MANIFEST_PATH = ".mizzen/manifest.json";

/** The files of a build and the hash of all of them: what the manifest's `build` field holds. */
export interface BuildRecord {
  /** SHA-256 of the lines {@link buildHashOf} makes from `files`, as 64 lowercase hex characters. */
  readonly hash: string;
  /** SHA-256 of each file's bytes, keyed by the file's path relative to the output folder. */
  readonly files: Readonly<Record<string, string>>;
}

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
export function hashOf(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The one hash of a build from its per-file hashes: one line per file, sorted by path, so the same files give the
 * same hash whatever order they were hashed in.
 */
export function buildHashOf(files: Readonly<Record<string, string>>): string {
  const text = Object.keys(files)
    .sort(byCodePoint)
    .map((path) => `${path}\0${files[path]}\n`)
    .join("");
  return hashOf(text);
}

/**
 * Hashes every file under `root` in path order, leaving out the manifest that records the result. `verify` uses this
 * on a built folder, and {@link recordBuildHash} uses it on the staging folder before the build is swapped in.
 */
export async function fingerprint(root: string): Promise<BuildRecord> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    paths.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  paths.sort(byCodePoint);

  const files: Record<string, string> = {};
  for (const path of paths) {
    if (path === MANIFEST_PATH) continue;
    files[path] = hashOf(await readFile(join(root, path)));
  }
  return { hash: buildHashOf(files), files };
}

/**
 * Writes the build's fingerprint into the manifest already in `root`, and returns the hash. A folder with no
 * manifest (a custom outputs folder, or the manifest output switched off) is left as it is.
 */
export async function recordBuildHash(root: string): Promise<string | undefined> {
  const path = join(root, MANIFEST_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const record = await fingerprint(root);
  const manifest = JSON.parse(text) as Record<string, unknown>;
  manifest.build = record;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return record.hash;
}
