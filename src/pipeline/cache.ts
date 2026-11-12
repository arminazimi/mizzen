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
 * Every cache operation takes the folder {@link LOCK_NAME} in the cache root, so readers never see an entry while a
 * writer replaces it and pruning never removes an entry being read or written. A lock is abandoned when the process it
 * recorded died, or when it never recorded an owner and is older than {@link OWNER_GRACE_MS}; age alone never breaks a
 * lock whose owner is alive, so a restore or write that legitimately takes minutes keeps its exclusivity instead of
 * being overlapped by a competitor. A waiter gives up after {@link LOCK_WAIT_MS} and builds cold, which costs one cold
 * build rather than a hung one, and an operation that lost ownership publishes and prunes nothing. After a write, at
 * most {@link CACHE_RETENTION} entries are kept: the newest,
 * including the entry just written. An entry is copied into a temporary folder, checked file by file, published with
 * one rename, and only then does pruning run; an interrupted staging or backup folder is removed by the next operation.
 *
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CONFIG_FILE } from "../config/load.ts";
import type { Diagnostic, SiteConfig } from "../contracts/index.ts";
import { discover } from "../content/discover.ts";
import { version } from "../index.ts";

/** Bumped when the meaning of an entry changes, so an entry written by an older engine is never trusted. */
export const CACHE_FORMAT = 2;

/** How many entries a cache keeps, newest first. A prune never removes the entry it just wrote. */
export const CACHE_RETENTION = 4;

/** The folder in the cache root that every read, write, and prune takes, so they never overlap. */
const LOCK_NAME = ".lock";

/** A recovery guard untouched for this long belongs to a breaker that died; only guards age out, never locks. */
const STALE_MS = 120_000;

/** A lock folder with no owner is still being created, or was abandoned; after this long it is abandoned. */
const OWNER_GRACE_MS = 500;

/** How long an operation waits for the lock before it gives up and builds cold. */
const LOCK_WAIT_MS = 20_000;

/** Delay between attempts to take a busy lock. */
const LOCK_RETRY_MS = 25;

/** Prefixes of the folders a write stages and swaps through; leftovers are abandoned state. */
const TEMP_PREFIX = ".tmp-";
const OLD_PREFIX = ".old-";

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

/** A held cache lock, or why it could not be taken. */
type LockRead = { readonly token: string } | "missing" | "failed";

/** The PID in an owner file, or `undefined` when it is not one this module wrote. */
function ownerPid(owner: string): number | undefined {
  const pid = Number.parseInt(owner.split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The PID a creator recorded together with its ownership token, or `undefined` for an unfinished owner file. */
function ownerRecorded(owner: string): number | undefined {
  const pid = ownerPid(owner);
  const lines = owner.split("\n");
  return pid !== undefined && (lines[1] ?? "").trim() !== "" ? pid : undefined;
}

/**
 * True when the process that wrote `owner` (a PID and a token, one per line) is gone. Unknown means alive.
 *
 * A signal of `0` proves presence, not identity, and #109 forbids weighing a live PID against age, so nothing here can
 * notice the OS handing a dead owner's PID to an unrelated process: such a lock reads as owned and is not broken. The
 * cache stays correct anyway, because a competitor only ever waits {@link LOCK_WAIT_MS} and builds cold, publishes and
 * prunes nothing, and recovery resumes once that recycled PID is freed: the cost is the speedup, never the output.
 * `EPERM` (a PID we may not signal, so a process of another user) counts as alive for the same reason: calling it dead
 * would let a competitor break a lock whose owner is running.
 */
function ownerIsDead(owner: string): boolean {
  const pid = ownerPid(owner);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as { code?: unknown }).code === "ESRCH";
  }
}

/** What a breaker saw: the lock folder's inode and owner bytes, so replacement is provable. */
export interface CacheLockProbe {
  readonly ino: number;
  readonly owner: string | undefined;
  readonly abandoned: boolean;
}

/** Reads a lock and decides whether it may be broken; `undefined` when the lock vanished. */
async function probeAbandonedLock(lock: string): Promise<CacheLockProbe | undefined> {
  const info = await stat(lock).catch(() => undefined);
  // A lock that vanished was released; the caller retries instead of removing a fresh lock that replaced it.
  if (info === undefined) return undefined;
  const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
  if (owner === undefined || ownerRecorded(owner) === undefined) {
    // No owner was recorded, so nothing is working under this lock: it is either still being created by a process
    // that has not written its owner yet, or the crash of one that never will. Only the grace period separates them.
    return { ino: info.ino, owner, abandoned: Date.now() - info.mtimeMs > OWNER_GRACE_MS };
  }
  // Age alone never abandons a lock. A whole-build restore or write of a large site is expected to take minutes, and
  // breaking it then would let a second operation publish or prune over it. Recovery waits for the owner to die, and
  // the one thing it cannot tell apart (a dead owner whose PID was reused) is written on `ownerIsDead`.
  return { ino: info.ino, owner, abandoned: ownerIsDead(owner) };
}

/** Serializes breakers for one lock; a guard left by a dead breaker is recovered like the lock itself. */
async function acquireBreakGuard(lock: string): Promise<string | undefined> {
  const guard = `${lock}.recover`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(guard, `${process.pid}\n${randomUUID()}\n`);
      return guard;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") return undefined;
      if (attempt > 0) return undefined;
      const info = await stat(guard).catch(() => undefined);
      const owner = await readFile(guard, "utf8").catch(() => undefined);
      if (info === undefined || Date.now() - info.mtimeMs < STALE_MS) return undefined;
      if (owner !== undefined && !ownerIsDead(owner)) return undefined;
      // shortcut: two breakers may both recover a guard left by a process that died; the inode check
      // under the new guard still protects a lock another breaker just made.
      await rm(guard, { force: true }).catch(() => undefined);
    }
  }
  return undefined;
}

/** Breaks the lock only while it is still the one `probe` saw, under a guard that serializes breakers. */
async function breakAbandonedLock(lock: string, probe: CacheLockProbe): Promise<boolean> {
  if (!probe.abandoned) return false;
  const guard = await acquireBreakGuard(lock);
  if (guard === undefined) return false;
  try {
    const info = await stat(lock).catch(() => undefined);
    const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
    // The inode alone is not enough: a filesystem may reuse it for the replacement lock immediately.
    if (info === undefined || info.ino !== probe.ino || owner !== probe.owner) return false;
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    await rm(guard, { force: true }).catch(() => undefined);
  }
}

/**
 * Takes the cache lock, waiting a bounded time for another operation. A missing cache root is a miss, and any other
 * failure means the cache is unusable this run: both leave the caller to build cold rather than hang.
 */
async function lockCache(cacheRoot: string): Promise<LockRead> {
  const lock = join(cacheRoot, LOCK_NAME);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() >= deadline) return "failed";
    try {
      await mkdir(lock);
      try {
        await writeFile(join(lock, "owner"), `${process.pid}\n${token}\n`);
      } catch {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        return "failed";
      }
      return { token };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") return "missing";
      if (code !== "EEXIST") return "failed";
      const probe = await probeAbandonedLock(lock);
      if (probe !== undefined && (await breakAbandonedLock(lock, probe))) continue;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/** True when the lock still carries this operation's token, so its shared writes are still exclusive. */
async function ownsLock(cacheRoot: string, token: string): Promise<boolean> {
  const owner = await readFile(join(cacheRoot, LOCK_NAME, "owner"), "utf8").catch(() => undefined);
  return owner !== undefined && owner.includes(token);
}

/** Releases a lock this call took. A lock since broken and retaken by another operation is left alone. */
async function unlockCache(cacheRoot: string, token: string): Promise<void> {
  const lock = join(cacheRoot, LOCK_NAME);
  const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
  if (owner === undefined) {
    // Another operation may be between creating the lock and writing its owner; leave a fresh one alone.
    const info = await stat(lock).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs < OWNER_GRACE_MS) return;
  } else if (!owner.includes(token) && !ownerIsDead(owner)) {
    return;
  }
  await rm(lock, { recursive: true, force: true }).catch(() => undefined);
}

/** The lock primitives, exported so the concurrency tests can drive two breakers deterministically. */
export const cacheLockInternals = {
  probeAbandonedLock,
  breakAbandonedLock,
  lockCache,
  unlockCache,
  ownsLock,
};

/** Removes staging, backup, and lock state left by an operation that died; called only while holding the lock. */
async function cleanAbandoned(cacheRoot: string): Promise<void> {
  try {
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(TEMP_PREFIX) || entry.name.startsWith(OLD_PREFIX)) {
        await rm(join(cacheRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch {
    // A cache that cannot be swept is still correct; the stale folders cost only disk.
  }
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

/** Reads and checks an entry at `dir`. Missing bytes are a miss, bad bytes corruption, another format incompatible. */
async function readEntryAt(dir: string, key: string): Promise<EntryRead> {
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

/** Reads and checks the entry for `key`. A key that is not a key can name nothing. */
async function readEntry(cacheRoot: string, key: string): Promise<EntryRead> {
  if (!KEY.test(key)) return { reason: "missing" };
  return readEntryAt(join(cacheRoot, key), key);
}

/** True when every file in `dir` still matches the manifest, so only a complete entry is ever published. */
async function isCompleteEntry(dir: string, key: string): Promise<boolean> {
  const read = await readEntryAt(dir, key);
  if ("reason" in read) return false;
  try {
    await inBatches(read.entry.manifest.files, 32, async (file) => {
      const bytes = await readFile(join(dir, "out", file));
      if (hashOf(bytes) !== read.entry.manifest.hashes[file]) throw new Error(`cache: "${file}" does not match its hash`);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the entry for `key` into a fresh staging folder beside `out`, checking every file against its hash as it
 * reads it, so a corrupt or half-written entry is a miss rather than bad output. Returns `undefined` when there is no
 * usable entry, reporting why; the caller then builds cold. The cache lock is held while the entry is read, so a
 * concurrent writer cannot replace it between the manifest and its files.
 */
export async function restoreCache(
  cacheRoot: string,
  key: string,
  out: string,
  options: RestoreOptions = {},
): Promise<CacheRestore | undefined> {
  const held = await lockCache(cacheRoot);
  if (typeof held === "string") {
    options.onMiss?.(held === "missing" ? "missing" : "corrupt");
    return undefined;
  }

  try {
    await cleanAbandoned(cacheRoot);
    if (!(await ownsLock(cacheRoot, held.token))) {
      options.onMiss?.("corrupt");
      return undefined;
    }
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
      // A lock broken while the entry was being read means another operation may prune it; report a miss.
      if (!(await ownsLock(cacheRoot, held.token))) {
        await rm(staging, { recursive: true, force: true });
        options.onMiss?.("corrupt");
        return undefined;
      }
      return { staging, files: [...files].sort(byCodePoint), diagnostics: read.entry.manifest.diagnostics };
    } catch {
      await rm(staging, { recursive: true, force: true });
      options.onMiss?.("corrupt");
      return undefined;
    }
  } finally {
    await unlockCache(cacheRoot, held.token);
  }
}

/**
 * Writes an entry whole: a staged folder beside the target, checked file by file, then one rename. An existing entry
 * is moved aside first and put back if the rename fails, so a failed write never loses the entry it replaced. The
 * caller holds the cache lock, so no reader observes the target between the two renames.
 */
async function writeEntry(
  cacheRoot: string,
  key: string,
  manifest: CacheManifest,
  source: string,
  owns: () => Promise<boolean>,
): Promise<boolean> {
  const temp = await mkdtemp(join(cacheRoot, TEMP_PREFIX));
  try {
    await cp(source, join(temp, "out"), { recursive: true });
    await writeFile(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (!(await isCompleteEntry(temp, key))) return false;

    // Another operation may have broken and retaken a lock that outlived its lease; never publish then.
    if (!(await owns())) return false;
    const target = join(cacheRoot, key);
    const backup = join(cacheRoot, `${OLD_PREFIX}${key}-${randomUUID()}`);
    let replaced = false;
    try {
      await rename(target, backup);
      replaced = true;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    }
    try {
      await rename(temp, target);
    } catch (err) {
      if (replaced) await rename(backup, target).catch(() => undefined);
      throw err;
    }
    if (replaced) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Removes entries beyond the newest {@link CACHE_RETENTION}, keeping the entry just written. The caller holds the cache
 * lock, so every other entry is idle: pruning can remove neither an entry being read nor one being written.
 */
async function prune(cacheRoot: string, keep: string): Promise<void> {
  try {
    const entries: { name: string; path: string; mtime: number }[] = [];
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
      const path = join(cacheRoot, entry.name);
      const info = await stat(path).catch(() => undefined);
      entries.push({ name: entry.name, path, mtime: info?.mtimeMs ?? 0 });
    }
    entries.sort((a, b) => b.mtime - a.mtime || byCodePoint(b.name, a.name));

    const newest = entries.slice(0, CACHE_RETENTION);
    const retained = new Set(newest.map((entry) => entry.name));
    retained.add(keep);
    if (retained.size > CACHE_RETENTION) {
      const oldest = newest.at(-1);
      if (oldest !== undefined) retained.delete(oldest.name);
    }

    for (const entry of entries) {
      if (!retained.has(entry.name)) await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // A cache that cannot be pruned is still correct; it costs only disk.
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

    await mkdir(cacheRoot, { recursive: true });
    const held = await lockCache(cacheRoot);
    if (typeof held === "string") return;
    try {
      await cleanAbandoned(cacheRoot);
      const owns = () => ownsLock(cacheRoot, held.token);
      if (!(await owns())) return;
      if (await writeEntry(cacheRoot, key, manifest, source, owns)) {
        if (await owns()) await prune(cacheRoot, key);
      }
    } finally {
      await unlockCache(cacheRoot, held.token);
    }
  } catch {
    // The build already succeeded; a cache failure never changes that.
  }
}

/** The default cache folder of a site: `<root>/.mizzen/cache`. */
export function cacheRootOf(root: string): string {
  return join(resolve(root), CACHE_DIR);
}
