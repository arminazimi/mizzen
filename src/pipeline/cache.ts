/**
 * A whole-build cache for `mizzen build` (#1060): the output of a build is kept in `.mizzen/cache` and copied back
 * when every input that shaped it is unchanged.
 *
 * The key is one SHA-256 of the site's config file and its resolved config values, every discovered source file (pages,
 * assets, app pages, and `_data`), the navigation file, every file of the theme, every file of the outputs folder, the
 * `defaultLayout` and `themeFiles` options, the engine's version, the runtime's version, and {@link CACHE_FORMAT}.
 * Paths and bytes count; timestamps do not. Config and navigation are part of the same hash as the pages, so changing
 * either misses the cache for every page.
 *
 * The entry holds a copy of the finished output folder and `manifest.json` with the file list, each file's hash, a
 * checksum of the manifest itself, and the build's diagnostics. A hit is verified file by file before it is restored,
 * so a corrupt or half-written entry is a miss, never bad output. {@link restoreCache} reports whether an unusable
 * entry was missing, corrupt, or written by an incompatible version. Every failure here is swallowed by
 * {@link restoreCache} and {@link writeCache}: a cache that cannot be read or written leaves the build to run cold.
 *
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILE } from "../config/load.ts";
import type { Diagnostic, SiteConfig } from "../contracts/index.ts";
import { discover } from "../content/discover.ts";
import { version } from "../index.ts";

/** Bumped when the meaning of an entry changes, so an entry written by an older engine is never trusted. */
export const CACHE_FORMAT = 2;

/** Folder under a site root that holds the cache, relative to the root. */
export const CACHE_DIR = ".mizzen/cache";

/** Folders that never affect a build, skipped while hashing a theme or outputs folder. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".mizzen", "dist", "test"]);

/** A key has 64 lowercase hexadecimal characters, and so does a directory named after one. */
const KEY = /^[0-9a-f]{64}$/;

/** What {@link cacheKey} needs. */
export interface CacheKeyOptions {
  /** Absolute site root. */
  readonly root: string;
  /** Absolute source folder, already resolved from the config. */
  readonly sourceDir: string;
  /** The site config as loaded from the root. */
  readonly config: SiteConfig;
  /** Absolute theme root. */
  readonly themeRoot: string;
  /** Absolute folder the outputs are read from. */
  readonly outputsDir: string;
  /** Layout for a page that names none. */
  readonly defaultLayout?: string;
  /** Theme files copied into the output. */
  readonly themeFiles?: readonly string[];
  /** The engine version folded into the key. Default: the engine's `version`. */
  readonly engineVersion?: string;
  /** The runtime folded into the key. Default: the running Node and ICU versions. */
  readonly runtimeVersion?: string;
}

/** The file list and diagnostics of a cache hit. */
export interface CacheRestore {
  /** A new staging folder holding the restored output, ready for the caller to move into place. */
  readonly staging: string;
  /** Every file restored, relative to the staging folder, sorted by path. */
  readonly files: readonly string[];
  /** The findings of the build that wrote the entry, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Why an entry could not be used: no entry, unreadable bytes, or an entry this engine must not read. */
export type CacheMissReason = "missing" | "corrupt" | "incompatible";

/** What {@link restoreCache} takes besides the entry's identity. */
export interface RestoreOptions {
  /** Called with the reason a hit was not used. Reporting never changes the restored output. */
  readonly onMiss?: (reason: CacheMissReason) => void;
}

/** What a cache entry records. */
interface CacheManifest {
  readonly version: number;
  readonly key: string;
  readonly engine: string;
  readonly files: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly diagnostics: readonly Diagnostic[];
  /** SHA-256 of every other field, so a corrupted manifest is a miss rather than stale diagnostics. */
  readonly checksum: string;
}

/** The part of a manifest a hit relies on; {@link checksumOf} covers exactly this. */
type CachePayload = Omit<CacheManifest, "checksum">;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
function hashOf(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** JSON with object keys sorted at every level, so equal config values always hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(byCodePoint)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of the manifest's payload; the file list, hashes, and diagnostics are as much an entry as its output. */
function checksumOf(payload: CachePayload): string {
  return hashOf(
    JSON.stringify({
      version: payload.version,
      key: payload.key,
      engine: payload.engine,
      files: payload.files,
      hashes: payload.hashes,
      diagnostics: payload.diagnostics,
    }),
  );
}

/** True for a path an entry may name: relative, `/`-separated, and with no empty, `.`, or `..` segment. */
function isInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Every file under `dir`, skipping folders that cannot affect a build, sorted by path. A missing folder has none. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(current, entry.name), path);
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  }

  await walk(dir, "");
  return found.sort(byCodePoint);
}

/** Runs `run` for every item, at most `limit` at a time, so a thousand small reads stay inside the file descriptor limit. */
async function inBatches<T>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

/** One file of the cache key: a label that names its role, and where to read it. */
interface KeyInput {
  readonly label: string;
  readonly path: string;
}

/**
 * The cache key of a build: SHA-256 of everything that shapes the output. Config and navigation are part of the same
 * hash, so a change to either invalidates every page. Files are read in parallel but hashed in a fixed order; a missing
 * file adds no digest, so its appearance changes the key, and a file of empty bytes never stands in for a missing one.
 */
export async function cacheKey(options: CacheKeyOptions): Promise<string> {
  const engine = options.engineVersion ?? version;
  const runtime = options.runtimeVersion ?? `${process.versions.node}/${process.versions.icu ?? ""}`;
  const themeFiles = [...new Set(options.themeFiles ?? [])].sort(byCodePoint);
  const inputs: KeyInput[] = [{ label: "config", path: join(options.root, CONFIG_FILE) }];

  const files = await discover(options.sourceDir, {
    include: options.config.include,
    exclude: options.config.exclude,
  });
  for (const file of files) {
    inputs.push({ label: `source/${file.kind}/${file.path}`, path: join(options.sourceDir, file.path) });
  }

  // The navigation file may live outside the source folder, so it is hashed on its own as well.
  inputs.push({ label: "navigation", path: resolve(options.root, options.config.navigation) });

  for (const path of await filesUnder(options.themeRoot)) {
    inputs.push({ label: `theme/${path}`, path: join(options.themeRoot, path) });
  }
  for (const path of await filesUnder(options.outputsDir)) {
    inputs.push({ label: `outputs/${path}`, path: join(options.outputsDir, path) });
  }

  const digests: string[] = new Array(inputs.length);
  await inBatches(inputs, 32, async (input, index) => {
    try {
      digests[index] = hashOf(await readFile(input.path));
    } catch {
      digests[index] = "";
    }
  });

  const hash = createHash("sha256");
  hash.update("mizzen-cache\0");
  hash.update(`${CACHE_FORMAT}\0${engine}\0${runtime}\0`);
  // The config values matter as well as the file: a missing config takes its title from the folder name.
  hash.update(`config\0${canonicalJson(options.config)}\0`);
  hash.update(`defaultLayout\0${options.defaultLayout ?? ""}\0`);
  hash.update(`themeFiles\0${themeFiles.join("\0")}\0`);
  for (let index = 0; index < inputs.length; index++) {
    hash.update(`${inputs[index]!.label}\0${digests[index]!}\0`);
  }
  return hash.digest("hex");
}

/** True when `value` is a manifest this version wrote and can trust the shape of. */
function isManifest(value: unknown): value is CacheManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<CacheManifest>;
  if (typeof manifest.version !== "number" || typeof manifest.key !== "string" || !KEY.test(manifest.key)) return false;
  if (typeof manifest.engine !== "string") return false;
  if (typeof manifest.checksum !== "string" || !KEY.test(manifest.checksum)) return false;
  if (!Array.isArray(manifest.files) || !manifest.files.every((file): file is string => typeof file === "string")) return false;
  if (typeof manifest.hashes !== "object" || manifest.hashes === null) return false;
  if (!Array.isArray(manifest.diagnostics)) return false;
  return manifest.diagnostics.every(
    (d): boolean =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Diagnostic).id === "string" &&
      typeof (d as Diagnostic).message === "string" &&
      ((d as Diagnostic).severity === "error" ||
        (d as Diagnostic).severity === "warning" ||
        (d as Diagnostic).severity === "info"),
  );
}

/** An entry that can be restored, or why there is none. */
type EntryRead =
  | { readonly entry: { readonly dir: string; readonly manifest: CacheManifest } }
  | { readonly reason: CacheMissReason };

/** Reads and checks an entry. A missing folder is a miss, bad bytes are corruption, and another format is incompatible. */
async function readEntry(cacheRoot: string, key: string): Promise<EntryRead> {
  if (!KEY.test(key)) return { reason: "missing" };
  const dir = join(cacheRoot, key);
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "corrupt" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) return { reason: "corrupt" };
  const manifest = parsed as Partial<CacheManifest>;
  if (manifest.version !== CACHE_FORMAT || manifest.engine !== version) return { reason: "incompatible" };
  if (!isManifest(parsed) || parsed.key !== key) return { reason: "corrupt" };
  if (parsed.checksum !== checksumOf(parsed)) return { reason: "corrupt" };

  for (const file of parsed.files) {
    if (!isInside(file)) return { reason: "corrupt" };
    const expected = parsed.hashes[file];
    if (typeof expected !== "string" || !KEY.test(expected)) return { reason: "corrupt" };
  }
  return { entry: { dir, manifest: parsed } };
}

/**
 * Copies the entry for `key` into a fresh staging folder beside `out`, checking every file against its hash as it
 * reads it, so a corrupt or half-written entry is a miss rather than bad output. Returns `undefined` when there is no
 * usable entry, reporting why; the caller then builds cold.
 */
export async function restoreCache(
  cacheRoot: string,
  key: string,
  out: string,
  options: RestoreOptions = {},
): Promise<CacheRestore | undefined> {
  const read = await readEntry(cacheRoot, key);
  if ("reason" in read) {
    options.onMiss?.(read.reason);
    return undefined;
  }

  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(out)}-build-`));
  try {
    const source = join(read.entry.dir, "out");
    const files = read.entry.manifest.files;
    const directories = new Set(files.map((file) => dirname(join(staging, file))));
    await Promise.all([...directories].map((dir) => mkdir(dir, { recursive: true })));
    await inBatches(files, 32, async (file) => {
      const bytes = await readFile(join(source, file));
      if (hashOf(bytes) !== read.entry.manifest.hashes[file]) throw new Error(`cache: "${file}" does not match its hash`);
      await writeFile(join(staging, file), bytes);
    });
    return { staging, files: [...files].sort(byCodePoint), diagnostics: read.entry.manifest.diagnostics };
  } catch {
    await rm(staging, { recursive: true, force: true });
    options.onMiss?.("corrupt");
    return undefined;
  }
}

/** Writes an entry whole: a temporary folder beside the target, then one rename, so a reader never sees half an entry. */
async function writeEntry(cacheRoot: string, key: string, manifest: CacheManifest, source: string): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  const temp = await mkdtemp(join(cacheRoot, ".tmp-"));
  try {
    await cp(source, join(temp, "out"), { recursive: true });
    await writeFile(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const target = join(cacheRoot, key);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Removes entries for other keys, best effort: the cache holds the build of the inputs that ran last, not one copy per
 * edit. A failed removal or another process's entry is harmless; it is never read unless its key is the current one.
 */
async function prune(cacheRoot: string, keep: string): Promise<void> {
  try {
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && KEY.test(entry.name) && entry.name !== keep) {
        await rm(join(cacheRoot, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // A cache that cannot be pruned is still correct.
  }
}

/**
 * Records a finished build under `key`, with its files and diagnostics. The write is atomic and complete or absent:
 * a file list that does not match `source` writes no entry at all. Never throws: a cache that cannot be written only
 * costs the next build its speed.
 */
export async function writeCache(
  cacheRoot: string,
  key: string,
  source: string,
  files: readonly string[],
  diagnostics: readonly Diagnostic[],
): Promise<void> {
  try {
    if (!KEY.test(key)) return;
    const sorted = [...files].filter(isInside).sort(byCodePoint);
    const hashes: Record<string, string> = {};
    await inBatches(sorted, 32, async (file) => {
      hashes[file] = hashOf(await readFile(join(source, file)));
    });
    const payload: CachePayload = {
      version: CACHE_FORMAT,
      key,
      engine: version,
      files: sorted,
      hashes,
      diagnostics,
    };
    const manifest: CacheManifest = { ...payload, checksum: checksumOf(payload) };
    await writeEntry(cacheRoot, key, manifest, source);
    await prune(cacheRoot, key);
  } catch {
    // The build already succeeded; a cache failure never changes that.
  }
}

/** The default cache folder of a site: `<root>/.mizzen/cache`. */
export function cacheRootOf(root: string): string {
  return join(resolve(root), CACHE_DIR);
}
