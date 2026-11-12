import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DiscoveredFile } from "../content/discover.ts";

/** One file the assets unit wrote to the output folder. */
export interface CopiedFile {
  /** Where the file came from: relative to the site source, or to the theme root for theme assets. */
  readonly from: string;
  /** Path of the written file, relative to the output folder, using `/`. */
  readonly path: string;
  /** SHA-256 of the file's bytes, as 16 lowercase hex characters. */
  readonly hash: string;
}

/** What the assets unit needs. Discovery has already run; the unit copies only what it is handed. */
export interface CopyAssetsOptions {
  /** Absolute path of the site source folder the discovered paths are relative to. */
  readonly source: string;
  /** Absolute path of the output folder; created when missing. */
  readonly out: string;
  /** Files discovery found. `asset` and `app` files are copied; `doc` and `data` files are not. */
  readonly files: readonly DiscoveredFile[];
  /** Absolute path of the theme's root folder. */
  readonly themeRoot?: string;
  /**
   * Theme files to copy, as paths relative to the theme root. Each lands at `assets/theme/` with the hash in its
   * name. An entry must be a `/`-separated relative path with no empty, `.` or `..` segment, and must stay inside
   * the theme root once symbolic links are resolved; anything else is refused before a byte is read or written.
   */
  readonly themeFiles?: readonly string[];
}

/** What the assets unit wrote. */
export interface CopyAssetsResult {
  /** Every written file, sorted by output path, so runs are deterministic. */
  readonly files: readonly CopiedFile[];
}

/** Folder under the output that hashed theme assets go to, so they can never collide with site paths. */
const THEME_OUT = "assets/theme";

/** Length of the hash in a file name: 16 hex characters is far beyond collision range for a site. */
const HASH_LENGTH = 16;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
}

/** `css/main.css` becomes `css/main-<hash>.css`; the extension is kept so servers still see the type. */
function hashedName(path: string, hash: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1, dot > slash ? dot : undefined);
  const ext = dot > slash ? path.slice(dot) : "";
  return `${dir}${base}-${hash}${ext}`;
}

/**
 * Output path of a theme file with these bytes: `assets/theme/<rel>` with the hash in the name. This is a name and
 * not a promise: {@link copyAssets} validates `rel` and checks the write location on its own, because the hashed
 * name still carries whatever folders `rel` had.
 */
export function themeAssetPath(rel: string, bytes: Uint8Array): string {
  return `${THEME_OUT}/${hashedName(rel, hashOf(bytes))}`;
}

/** True when the error says a path, or a parent of it, is simply not there, as opposed to being unreachable. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** True when `target` is `root` itself or below it. Both are platform paths with no symbolic links left in them. */
function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * `path` with its symbolic links resolved. A tail that does not exist yet is appended to the real path of its
 * nearest existing parent, so a folder the unit is about to create is still compared as a real path.
 */
async function realBase(path: string): Promise<string> {
  const missing: string[] = [];
  let dir = path;
  for (;;) {
    try {
      const real = await realpath(dir);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (err) {
      if (!isAbsent(err)) {
        throw new TypeError(`copyAssets: folder "${path}" could not be resolved (${String((err as NodeJS.ErrnoException).code ?? err)}).`);
      }
      missing.push(basename(dir));
      const parent = dirname(dir);
      if (parent === dir) return resolve(path);
      dir = parent;
    }
  }
}

/**
 * True when `rel` names a file inside its base folder lexically: a non-empty `/`-separated path with no empty, `.`
 * or `..` segment, no backslash, no drive letter and no leading slash. `join` accepts every one of those quietly,
 * so they are refused by name instead of normalized away.
 */
function isRelInside(rel: string): boolean {
  if (rel.length === 0 || rel.includes("\\") || rel.includes("\0")) return false;
  if (rel.startsWith("/") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * `rel`, already checked by {@link isRelInside}, resolved under the real `base`, one segment at a time.
 *
 * The lexical join cannot leave `base`, so only a symbolic link can: each segment that exists is inspected, and a
 * link is followed only when its real target stays inside `base`. The first missing segment ends the walk, since
 * nothing below it exists yet to redirect anything. The caller reads and writes the path this returns, never the
 * path it handed in, so a link swapped in after the check cannot send the bytes somewhere else.
 */
async function resolveInside(rel: string, base: string, what: string): Promise<string> {
  const segments = rel.split("/");
  let at = base;
  let i = 0;
  for (; i < segments.length; i++) {
    const candidate = join(at, segments[i]!);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(candidate);
    } catch (err) {
      if (isAbsent(err)) break;
      throw new TypeError(`copyAssets: ${what} could not be inspected (${String((err as NodeJS.ErrnoException).code ?? err)}).`);
    }
    if (!info.isSymbolicLink()) {
      at = candidate;
      continue;
    }
    let target: string;
    try {
      target = await realpath(candidate);
    } catch (err) {
      throw new TypeError(
        `copyAssets: ${what} is a symbolic link that does not resolve inside its folder (${String((err as NodeJS.ErrnoException).code ?? err)}).`,
      );
    }
    if (!isWithin(base, target)) {
      throw new TypeError(`copyAssets: ${what} leaves its folder through the symbolic link "${candidate}".`);
    }
    at = target;
  }
  return join(at, ...segments.slice(i));
}

/** One theme asset that passed every check: the bytes read from the real theme root, and where they go. */
interface ThemeWrite {
  readonly from: string;
  readonly path: string;
  readonly abs: string;
  readonly bytes: Buffer;
}

async function write(from: string, path: string, abs: string, bytes: Uint8Array): Promise<CopiedFile> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return { from, path, hash: hashOf(bytes) };
}

/**
 * Copies assets to the output: site assets keep their paths, app pages pass through byte for byte, and theme assets
 * land under `assets/theme/` with the hash of their bytes in the name, so a changed file is a new URL. `doc` and
 * `data` files are never copied: docs are rendered, and `_data` is read by the engine.
 *
 * A theme asset is read from the real theme root and written inside the real output folder, and the two locations
 * are checked independently: a name that stays inside lexically can still be redirected by a symbolic link, and a
 * link inside the output can still send a write elsewhere. Every check runs, and every theme file is read, before
 * the unit writes anything, so a refused set leaves the output and everything outside it as it found them.
 */
export async function copyAssets(options: CopyAssetsOptions): Promise<CopyAssetsResult> {
  const { source, out, files } = options;
  const themeRoot = options.themeRoot;
  const requested = options.themeFiles ?? [];
  if (requested.length > 0 && themeRoot === undefined) {
    throw new TypeError("copyAssets: themeFiles given without themeRoot.");
  }
  for (const rel of requested) {
    if (!isRelInside(rel)) {
      throw new TypeError(
        `copyAssets: theme asset "${rel}" is not a relative path inside the theme root; use a \`/\`-separated path with no absolute, empty, "." or ".." segment and no backslash.`,
      );
    }
  }

  const themeReal = requested.length === 0 || themeRoot === undefined ? undefined : await realBase(themeRoot);
  const outReal = await realBase(out);

  // Reads first, and only then writes: a set with one bad entry in it copies nothing at all.
  const theme: ThemeWrite[] = [];
  if (themeReal !== undefined) {
    for (const rel of requested) {
      const bytes = await readFile(await resolveInside(rel, themeReal, `theme asset "${rel}"`));
      const path = `${THEME_OUT}/${hashedName(rel, hashOf(bytes))}`;
      const abs = await resolveInside(path, outReal, `theme asset "${rel}" destination`);
      theme.push({ from: rel, path, abs, bytes });
    }
  }

  const copied: CopiedFile[] = [];
  for (const file of files) {
    if (file.kind !== "asset" && file.kind !== "app") continue;
    const bytes = await readFile(join(source, file.path));
    copied.push(await write(file.path, file.path, join(out, file.path), bytes));
  }
  for (const item of theme) {
    copied.push(await write(item.from, item.path, item.abs, item.bytes));
  }

  copied.sort((a, b) => byCodePoint(a.path, b.path));
  return { files: copied };
}
