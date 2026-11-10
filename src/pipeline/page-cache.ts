/**
 * A per-page Markdown cache ([#1561]): every page's mdast tree is kept under `<dir>/<hash>.json`, keyed by the page's
 * expanded Markdown, the line its body starts on, the Markdown plugins (name and order), and the engine version.
 *
 * Only the parse stage is cached. Front matter, includes, titles, permalinks, navigation, data, facts, rendering, and
 * outputs all run every build, so a page cache hit produces exactly the tree a cold parse would. Changing one page
 * misses only that page; changing a plugin or its order misses every page; a corrupt, missing, stale, or half-written
 * entry is a miss, never bad content. Writes land in a temporary folder first and are renamed into place, so a reader
 * never sees half an entry.
 *
 * [#1561]: https://github.com/arminazimi/slipway/issues/1561
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Root } from "mdast";
import { version } from "../index.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../markdown/parse.ts";

/** Bumped when the meaning or shape of an entry changes, so an entry written by an older engine is never trusted. */
export const PAGE_CACHE_FORMAT = 1;

/** A key has 64 lowercase hexadecimal characters, and so does a file named after one. */
const KEY = /^[0-9a-f]{64}$/;

/** The part of a Markdown plugin that changes the parsed tree: its name and its order. */
export interface PageCachePlugin {
  readonly name: string;
  readonly order: number;
}

/** What {@link pageCache} needs. Both are only overridden by tests. */
export interface PageCacheOptions {
  /** The engine version folded into every key. Default: the engine's `version`. */
  readonly engineVersion?: string;
  /** Plugins folded into every key, in load order. Default: the plugins {@link loadMarkdownPlugins} returns. */
  readonly plugins?: readonly PageCachePlugin[];
}

/** A cache of parsed Markdown trees, stored as JSON under one folder. */
export interface PageCache {
  /** The key of a page: SHA-256 of its body, body line, plugin names and orders, and engine version. */
  key(body: string, bodyLine?: number): Promise<string>;
  /** The tree stored under `key`; `undefined` for a missing, corrupt, or stale entry. */
  get(key: string): Promise<Root | undefined>;
  /** Stores `tree` under `key`, atomically. A failed write is ignored: the next build parses the page again. */
  set(key: string, tree: Root): Promise<void>;
}

/** What an entry holds. `format` and `engine` are markers, so an entry from another format or engine is never read. */
interface PageCacheEntry {
  readonly format: number;
  readonly engine: string;
  readonly key: string;
  readonly tree: Root;
}

let defaultPlugins: Promise<readonly PageCachePlugin[]> | undefined;

/** The loaded plugins' names and orders, or their default. Loaded once per process. */
function pluginList(overridden: readonly PageCachePlugin[] | undefined): Promise<readonly PageCachePlugin[]> {
  if (overridden !== undefined) return Promise.resolve(overridden);
  defaultPlugins ??= loadMarkdownPlugins().then((plugins) =>
    plugins.map(({ name, order }) => ({ name, order })),
  );
  return defaultPlugins;
}

/** True when `value` is a tree this module wrote and can trust the shape of. */
function isTree(value: unknown): value is Root {
  if (typeof value !== "object" || value === null) return false;
  const tree = value as { type?: unknown; children?: unknown };
  return tree.type === "root" && Array.isArray(tree.children);
}

/** True when `value` is an entry for `key` written by this format and engine version. */
function isEntry(value: unknown, key: string, engine: string): value is PageCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PageCacheEntry>;
  return (
    entry.format === PAGE_CACHE_FORMAT &&
    entry.engine === engine &&
    entry.key === key &&
    isTree(entry.tree)
  );
}

/** A cache of parsed pages rooted at `dir`. Reads and writes never throw; a cache that fails only costs a parse. */
export function pageCache(dir: string, options: PageCacheOptions = {}): PageCache {
  const root = resolve(dir);
  const engine = options.engineVersion ?? version;
  const overridden = options.plugins;

  return {
    async key(body, bodyLine = 1) {
      const plugins = await pluginList(overridden);
      return createHash("sha256")
        .update(
          JSON.stringify({
            body,
            bodyLine,
            engineVersion: engine,
            plugins: plugins.map(({ name, order }) => ({ name, order })),
          }),
        )
        .digest("hex");
    },

    async get(key) {
      if (!KEY.test(key)) return undefined;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(root, `${key}.json`), "utf8"));
        if (!isEntry(parsed, key, engine)) return undefined;
        return parsed.tree;
      } catch {
        return undefined;
      }
    },

    async set(key, tree) {
      if (!KEY.test(key)) return;
      let temp: string | undefined;
      try {
        await mkdir(root, { recursive: true });
        temp = await mkdtemp(join(root, ".tmp-"));
        const entry: PageCacheEntry = { format: PAGE_CACHE_FORMAT, engine, key, tree };
        await writeFile(join(temp, "entry.json"), `${JSON.stringify(entry)}\n`);
        // One rename puts the entry in place, so no reader ever sees a partial file.
        await rename(join(temp, "entry.json"), join(root, `${key}.json`));
      } catch {
        // The build already succeeded; a cache failure never changes that.
      } finally {
        if (temp !== undefined) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** A cached parse: the tree, and whether this call had to parse it rather than read it from the cache. */
export interface CachedParse {
  readonly tree: Root;
  /** True when the page was parsed this run; false when the tree came from the cache. */
  readonly parsed: boolean;
}

/** Parses `body` through `cache`: a hit is returned as is, a miss is parsed, stored, and counted. */
export async function parseMarkdownWithCache(
  body: string,
  bodyLine: number,
  cache: PageCache,
): Promise<CachedParse> {
  const key = await cache.key(body, bodyLine);
  const cached = await cache.get(key);
  if (cached !== undefined) return { tree: cached, parsed: false };
  const tree = await parseMarkdown(body, bodyLine);
  await cache.set(key, tree);
  return { tree, parsed: true };
}

/** The tree for `body`, from `cache` when it is there and freshly parsed (and stored) otherwise. */
export async function parseMarkdownCached(body: string, bodyLine: number, cache: PageCache): Promise<Root> {
  return (await parseMarkdownWithCache(body, bodyLine, cache)).tree;
}
