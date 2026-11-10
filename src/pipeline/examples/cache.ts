/**
 * A content-addressed result cache for example runners (#1463).
 *
 * Each example result is stored under one SHA-256 key of its code, language, kind, and runtime. The key covers the
 * inputs that change what an example does; editing any of them misses the entry and runs the example again. The
 * runtime defaults to Node's `process.version` and the engine's {@link version}, so upgrading either reruns the
 * examples too.
 *
 * One JSON file per key lives in the cache folder, `<root>/.mizzen/examples` by default or the `dir` a caller names.
 * The folder is disposable: missing, unreadable, or corrupt entries are misses, and every failure here is swallowed.
 * An entry is written whole — a temporary folder then one rename — so a reader never sees half an entry and no
 * temporary file is left behind.
 *
 * Results are plain JSON objects. Wall-clock fields the runners report (`durationMs`) are removed before an entry is
 * written, so the same result always produces the same bytes; a hit returns `durationMs: 0` because no run happened.
 *
 * The cache is a build-local speed-up, not shared state: it is safe to delete at any time and needs no locking. Two
 * writers of the same key each write a complete file and the last rename wins.
 *
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../../index.ts";

/** Bumped when the meaning of a key or an entry changes, so an entry from an older engine is never trusted. */
export const EXAMPLE_CACHE_FORMAT = 1;

/** Folder under a site root that holds the example cache, relative to the root. */
export const EXAMPLE_CACHE_DIR = ".mizzen/examples";

/** A key has 64 lowercase hexadecimal characters, and so does a file named after one. */
const KEY = /^[0-9a-f]{64}$/;

/** The fields of a result that describe the run rather than what it produced. Removed before a result is stored. */
const TIMING_FIELDS: ReadonlySet<string> = new Set(["durationMs"]);

/** What {@link exampleCacheKey} hashes besides the runtime. */
export interface ExampleKeyInput {
  /** The snippet exactly as the runner receives it. */
  readonly code: string;
  /** Its language: `js`, `mjs`, `ts`, `bash`, `sh`, and anything a later runner adds. */
  readonly lang: string;
  /** Which runner produced the result, so two runners never share an entry (`node`, `shell`, and so on). */
  readonly kind: string;
}

/** What {@link exampleCache} needs. */
export interface ExampleCacheOptions {
  /** The cache folder itself. Wins over {@link root}; relative paths resolve against the working directory. */
  readonly dir?: string;
  /** The site root. The default cache folder is `<root>/.mizzen/examples`. Default root: the working directory. */
  readonly root?: string;
  /**
   * The runtime identity in every key. Default: Node's `process.version` and the engine's version. Pass this only to
   * pin a runtime a test or another host is meant to share.
   */
  readonly runtime?: string;
}

/** A cache on disk. Every method is total: a bad key, a missing folder, or a broken entry is a miss, never a throw. */
export interface ExampleCache {
  /** The absolute cache folder. It is created on the first {@link ExampleCache.set}. */
  readonly dir: string;
  /** The runtime string in every key this cache makes. */
  readonly runtime: string;
  /** The key of one example under this cache's runtime. */
  key: (input: ExampleKeyInput) => string;
  /** The stored result for `key`, or `undefined` when it is missing, corrupt, or from another format. */
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  /** Stores `result` under `key`, atomically and without its timing fields. A failure is a silent no-op. */
  set: <T>(key: string, result: T) => Promise<void>;
}

/** One example and the runner's result. */
export interface CachedRun<T> {
  /** The runner's result, or the stored one on a hit. */
  readonly result: T;
  /** True when the result came from the cache and the runner never ran. */
  readonly cached: boolean;
}

/** The shape of one file on disk. */
interface CacheEntry {
  readonly format: number;
  readonly key: string;
  readonly result: Readonly<Record<string, unknown>>;
}

/** The runtime a key uses when the caller names none: the Node version that ran the example and the engine version. */
export function defaultExampleRuntime(): string {
  return `${process.version} ${version}`;
}

/** SHA-256 of the code, language, kind, runtime, and format, as 64 lowercase hex characters. Deterministic. */
export function exampleCacheKey(input: ExampleKeyInput, runtime: string = defaultExampleRuntime()): string {
  const hash = createHash("sha256");
  hash.update(`mizzen-example-cache\0${EXAMPLE_CACHE_FORMAT}\0`);
  // A fixed field order, so the same values always hash to the same bytes.
  hash.update(JSON.stringify({ code: input.code, lang: input.lang, kind: input.kind, runtime }));
  return hash.digest("hex");
}

/** The default cache folder of a site: `<root>/.mizzen/examples`. */
export function exampleCacheDirOf(root: string): string {
  return join(resolve(root), EXAMPLE_CACHE_DIR);
}

/** True for a plain JSON object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is an entry this version wrote under `key` and whose result is a plain object. */
function isEntry(value: unknown, key: string): value is CacheEntry {
  if (!isPlainObject(value)) return false;
  return value.format === EXAMPLE_CACHE_FORMAT && value.key === key && isPlainObject(value.result);
}

/** The result as it is stored: a plain object without its timing fields, or `undefined` for anything else. */
function storable(result: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(result)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(result)) {
    if (!TIMING_FIELDS.has(field)) out[field] = value;
  }
  return out;
}

/**
 * Opens the cache at `options.dir`, or `<options.root>/.mizzen/examples` when no folder is named. Nothing is read or
 * written until {@link ExampleCache.get} or {@link ExampleCache.set} is called, so opening a cache cannot fail.
 */
export function exampleCache(options: ExampleCacheOptions = {}): ExampleCache {
  const dir = resolve(options.dir ?? exampleCacheDirOf(options.root ?? process.cwd()));
  const runtime = options.runtime ?? defaultExampleRuntime();

  return {
    dir,
    runtime,
    key: (input) => exampleCacheKey(input, runtime),
    async get<T = unknown>(key: string): Promise<T | undefined> {
      if (!KEY.test(key)) return undefined;
      try {
        const text = await readFile(join(dir, `${key}.json`), "utf8");
        const parsed: unknown = JSON.parse(text);
        if (!isEntry(parsed, key)) return undefined;
        return parsed.result as T;
      } catch {
        return undefined;
      }
    },
    async set<T>(key: string, result: T): Promise<void> {
      if (!KEY.test(key)) return;
      const stored = storable(result);
      if (stored === undefined) return;

      try {
        await mkdir(dir, { recursive: true });
        // A folder beside the target, so the rename below never crosses a file system and never exposes a half file.
        const temp = await mkdtemp(join(dir, ".tmp-"));
        try {
          const entry: CacheEntry = { format: EXAMPLE_CACHE_FORMAT, key, result: stored };
          const source = join(temp, "entry.json");
          const target = join(dir, `${key}.json`);
          await writeFile(source, `${JSON.stringify(entry)}\n`);
          try {
            await rename(source, target);
          } catch {
            // On Windows a rename does not replace an existing file; the entry is disposable, so replace it by hand.
            await rm(target, { force: true });
            await rename(source, target);
          }
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      } catch {
        // A cache that cannot be written only costs the next run its speed.
      }
    },
  };
}

/**
 * Runs `runner` unless the cache already holds the result for `input`: look the key up, return the stored result on a
 * hit, otherwise run once and store the result. A hit reports `durationMs: 0`, because nothing ran. Lookups and
 * stores are independent, so several examples can be cached in one build without coordination.
 */
export async function cachedRun<T extends { durationMs?: number }>(
  cache: ExampleCache,
  input: ExampleKeyInput,
  runner: () => Promise<T>,
): Promise<CachedRun<T>> {
  const key = cache.key(input);
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return { result: { ...hit, durationMs: 0 }, cached: true };

  const result = await runner();
  await cache.set(key, result);
  return { result, cached: false };
}
