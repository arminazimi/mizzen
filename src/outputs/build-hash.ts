/**
 * One SHA-256 for a whole build, recorded in `.mizzen/manifest.json` and checked by `mizzen verify` (#1252).
 *
 * Every file the build writes, except the manifest that records the result, is hashed; the whole-build hash is the
 * SHA-256 of one line per file (`<path>`, a NUL, the file's hash, and a line feed), with the paths sorted by code
 * point. The build and `verify` run the same rule, so both agree byte for byte.
 *
 * An identity describes reproducible content only: the path is relative with `/` separators, file times are not read,
 * and the metadata files an operating system adds to a folder (`.DS_Store`, `Thumbs.db`, `desktop.ini`, AppleDouble
 * `._*` files, and `__MACOSX` folders) are not part of it. A path that cannot be named unambiguously (absolute,
 * backslash, a `.` or `..` segment, or a control character) is an error rather than a guess.
 *
 * Only regular files carry identity. Directories are traversed but never hashed; a symlink, socket, FIFO, device, or
 * other special entry is unsupported and stops the fingerprint instead of silently disappearing from it. Links are
 * never followed, so hashing a folder cannot read anything outside it.
 *
 * The manifest cannot hash itself, so it is left out: a change to the record is not a change to the build. A site
 * file that replaces the manifest makes the build leave it alone.
 *
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile, type FileHandle } from "node:fs/promises";
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

/** A filesystem entry a build identity cannot include. `path` is a name no identity can represent. */
export type UnsupportedEntry = "symlink" | "socket" | "fifo" | "device" | "other" | "path";

/** Thrown by {@link fingerprint} for the first unsupported entry, in path order. */
export class UnsupportedEntryError extends TypeError {
  /** The entry's path relative to the fingerprinted folder, with `/` separators. */
  readonly path: string;
  /** What kind of entry it is. */
  readonly entry: UnsupportedEntry;

  constructor(path: string, entry: UnsupportedEntry) {
    super(
      entry === "path"
        ? `build-hash: "${path}" is not a path a build identity can name.`
        : `build-hash: "${path}" is a ${entry} entry; a build identity hashes regular files only.`,
    );
    this.name = "UnsupportedEntryError";
    this.path = path;
    this.entry = entry;
  }
}

/**
 * Names an operating system or archive tool adds to a folder. They are not site content: a checkout that carries
 * them still describes the same build.
 */
const PLATFORM_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes", "__MACOSX"]);

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
export function hashOf(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True for a path an identity can name without ambiguity: relative, `/`-separated, and free of control characters. */
export function isIdentityPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** True for a metadata file or folder an operating system adds, which no build identity includes. */
function isPlatformMetadata(path: string): boolean {
  return path.split("/").some((segment) => PLATFORM_METADATA.has(segment) || segment.startsWith("._"));
}

/** True for a path a manifest may record: an identity path that is neither the manifest nor platform metadata. */
export function isIdentityFile(path: string): boolean {
  return path !== MANIFEST_PATH && !isPlatformMetadata(path) && isIdentityPath(path);
}

/**
 * The one hash of a build from its per-file hashes: one line per file, sorted by path, so the same files give the
 * same hash whatever order they were hashed in. A path that identity cannot name without ambiguity is an error: two
 * different files could otherwise produce the same lines.
 */
export function buildHashOf(files: Readonly<Record<string, string>>): string {
  const paths = Object.keys(files).sort(byCodePoint);
  const ambiguous = paths.find((path) => !isIdentityPath(path));
  if (ambiguous !== undefined) {
    throw new TypeError(`build-hash: "${ambiguous}" is not a relative path a build identity can name.`);
  }
  return hashOf(paths.map((path) => `${path}\0${files[path]}\n`).join(""));
}

/** Reads a file without following a final symlink, so a fingerprint cannot leave the folder it was given. */
async function readNoFollow(root: string, path: string): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new UnsupportedEntryError(path, "symlink");
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UnsupportedEntryError(path, "other");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Collects the ordinary files under `dir`, or the unsupported entries that stop the identity from being complete. */
async function collect(
  root: string,
  dir: string,
  files: string[],
  unsupported: UnsupportedEntryError[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = relative(root, join(dir, entry.name)).split(sep).join("/");
    const kind: UnsupportedEntry | undefined = entry.isSymbolicLink()
      ? "symlink"
      : entry.isSocket()
        ? "socket"
        : entry.isFIFO()
          ? "fifo"
          : entry.isBlockDevice() || entry.isCharacterDevice()
            ? "device"
            : !entry.isFile() && !entry.isDirectory()
              ? "other"
              : undefined;
    if (kind !== undefined) {
      unsupported.push(new UnsupportedEntryError(path, kind));
      continue;
    }
    if (entry.isDirectory()) {
      if (!isPlatformMetadata(path)) await collect(root, join(dir, entry.name), files, unsupported);
      continue;
    }
    if (path === MANIFEST_PATH || isPlatformMetadata(path)) continue;
    if (!isIdentityPath(path)) {
      unsupported.push(new UnsupportedEntryError(path, "path"));
      continue;
    }
    files.push(path);
  }
}

/**
 * Hashes every regular file under `root` in path order, leaving out the manifest that records the result and the
 * metadata files an operating system adds. `verify` uses this on a built folder, and {@link recordBuildHash} uses it
 * on the staging folder before the build is swapped in.
 *
 * A symlink, socket, FIFO, device, or other special entry is an {@link UnsupportedEntryError}: including it would
 * read outside the folder or describe something that is not content, and ignoring it would hide a change.
 */
export async function fingerprint(root: string): Promise<BuildRecord> {
  const found: string[] = [];
  const unsupported: UnsupportedEntryError[] = [];
  await collect(root, root, found, unsupported);
  if (unsupported.length > 0) {
    unsupported.sort((a, b) => byCodePoint(a.path, b.path));
    throw unsupported[0];
  }
  found.sort(byCodePoint);

  // A null prototype keeps a file literally named `__proto__` from landing on the object's prototype, where the
  // hash would never see it.
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of found) files[path] = hashOf(await readNoFollow(root, path));
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
