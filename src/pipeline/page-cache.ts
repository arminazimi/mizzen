/**
 * A per-page Markdown cache (#1561): every page's mdast tree is kept under `<dir>/<hash>.json`, keyed by the page's
 * expanded Markdown, the line its body starts on, the Markdown plugins (name and order), the bytes of the code that
 * parses them, and the engine version.
 *
 * Only the parse stage is cached. Front matter, includes, titles, permalinks, navigation, data, facts, rendering, and
 * outputs all run every build, so a page cache hit produces exactly the tree a cold parse would. Changing one page
 * misses only that page; changing a plugin or its order misses every page; an implementation input that cannot be read
 * misses every page rather than trusting a tree this run cannot account for; a corrupt, missing, stale, or
 * half-written entry is a miss, never bad content, and an entry carries a checksum of its tree so a tampered tree is
 * never read. Writes land in a temporary folder first and are renamed into place, so a reader never sees half an entry.
 *
 * The implementation fingerprint (#106) is what keeps development honest: the parser module and the built-in plugin
 * modules are read in stable path order and folded into every key and every entry, so a cached tree cannot outlive a
 * behavior change while the package version stays fixed.
 *
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { version } from "../index.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../markdown/parse.ts";
import { moduleName, OWN_EXTENSION } from "../runtime/modules.ts";

/** Bumped when the meaning or shape of an entry changes, so an entry written by an older engine is never trusted. */
export const PAGE_CACHE_FORMAT = 3;

/** A key has 64 lowercase hexadecimal characters, and so does a file named after one. */
const KEY = /^[0-9a-f]{64}$/;

/** Why an entry could not be used: no entry, unreadable bytes, or an entry this engine must not read. */
export type PageCacheMissReason = "missing" | "corrupt" | "incompatible";

/** The part of a Markdown plugin that changes the parsed tree: its name and its order. */
export interface PageCachePlugin {
  readonly name: string;
  readonly order: number;
}

/** What {@link pageCache} needs. Every field but `onMiss` is only overridden by tests. */
export interface PageCacheOptions {
  /** The engine version folded into every key. Default: the engine's `version`. */
  readonly engineVersion?: string;
  /** Plugins folded into every key, in load order. Default: the plugins {@link loadMarkdownPlugins} returns. */
  readonly plugins?: readonly PageCachePlugin[];
  /**
   * The implementation fingerprint folded into every key, in place of the one read from the parser and plugin modules.
   * Default: the fingerprint of this engine's parser module and every built-in Markdown plugin module file.
   */
  readonly implementation?: string;
  /**
   * The module files whose bytes make up the implementation fingerprint, in place of the engine's own parser and
   * built-in plugin modules. The order they are named in does not matter: they are read in stable path order.
   */
  readonly implementationFiles?: readonly string[];
  /** Called with the reason an entry was not used. The page is parsed again. */
  readonly onMiss?: (reason: PageCacheMissReason) => void;
}

/** A cache of parsed Markdown trees, stored as JSON under one folder. */
export interface PageCache {
  /**
   * The key of a page: SHA-256 of its body, body line, plugin names and orders, engine version, and the fingerprint of
   * the parser and built-in plugin code.
   */
  key(body: string, bodyLine?: number): Promise<string>;
  /**
   * The tree stored under `key`; `undefined` for a missing, corrupt, or stale entry, or when this run cannot
   * fingerprint the implementation, reported to `onMiss`.
   */
  get(key: string): Promise<Root | undefined>;
  /** Stores `tree` under `key`, atomically. A failed write is ignored: the next build parses the page again. */
  set(key: string, tree: Root): Promise<void>;
}

/**
 * What an entry holds. `format`, `engine`, and `implementation` are markers, so an entry from another format, engine,
 * or parser code is never read.
 */
interface PageCacheEntry {
  readonly format: number;
  readonly engine: string;
  /** SHA-256 of the parser and built-in plugin bytes this entry was parsed by (#106). */
  readonly implementation: string;
  readonly key: string;
  /** SHA-256 of the tree's JSON, so a corrupted tree is a miss rather than bad content. */
  readonly checksum: string;
  readonly tree: Root;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** Where this engine keeps the code that parses Markdown: the parser module, the built-in plugin folder, their parent. */
function implementationSources(): { readonly parser: string; readonly plugins: string; readonly root: string } {
  const markdown = fileURLToPath(new URL("../markdown/", import.meta.url));
  return {
    parser: join(markdown, `parse${OWN_EXTENSION}`),
    plugins: join(markdown, "plugins"),
    root: dirname(markdown),
  };
}

/**
 * The engine's parser module and every built-in Markdown plugin module file — the files {@link loadMarkdownPlugins}
 * loads, named by path instead of by export. `undefined` when the plugin folder cannot be listed.
 */
async function builtInImplementationFiles(): Promise<readonly string[] | undefined> {
  const { parser, plugins } = implementationSources();
  let names: string[];
  try {
    names = (await readdir(plugins)).filter((name) => moduleName(name) !== null);
  } catch {
    // An implementation folder that cannot be listed is an implementation that cannot be fingerprinted.
    return undefined;
  }
  return [parser, ...names.map((name) => join(plugins, name))];
}

/** The name a fingerprint records for `file`: its path within the engine when it has one, its full path otherwise. */
function inputName(file: string, root: string): string {
  const within = relative(root, file).split(sep).join("/");
  return within === "" || within.startsWith("..") ? file.split(sep).join("/") : within;
}

/**
 * SHA-256 of the implementation modules' bytes: one line per file (`<name>`, a NUL, the file's hash, a line feed), the
 * files in stable path order, so the same code always gives the same digest whatever order it was named in and any
 * change to any of these files gives a different one. `undefined` when a file cannot be read: an implementation this
 * run cannot account for is a miss, never a stale fingerprint of it.
 */
async function fingerprintImplementation(files: readonly string[], root: string): Promise<string | undefined> {
  const lines: string[] = [];
  for (const file of [...files].sort(byCodePoint)) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file);
    } catch {
      return undefined;
    }
    lines.push(`${inputName(file, root)}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return createHash("sha256").update(lines.join("")).digest("hex");
}

let defaultImplementation: Promise<string | undefined> | undefined;

/**
 * The fingerprint of this engine's parser and built-in plugin modules.
 *
 * Read once per process, like the plugin list it sits beside: a process parses with the code it loaded, so the
 * fingerprint of the files on disk describes its parses exactly — and the next process, started after the edit, is the
 * one that sees the new bytes. A read that failed is not remembered, so a long-lived dev server can start caching
 * again once the file it could not read is readable.
 */
async function builtInImplementationFingerprint(): Promise<string | undefined> {
  defaultImplementation ??= (async () => {
    const files = await builtInImplementationFiles();
    return files === undefined ? undefined : fingerprintImplementation(files, implementationSources().root);
  })();
  const fingerprint = await defaultImplementation;
  if (fingerprint === undefined) defaultImplementation = undefined;
  return fingerprint;
}

/** True when `value` is an entry for `key` written by this format, engine version, and implementation code. */
function isEntry(value: unknown, key: string, engine: string, implementation: string): value is PageCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PageCacheEntry>;
  return (
    entry.format === PAGE_CACHE_FORMAT &&
    entry.engine === engine &&
    entry.implementation === implementation &&
    entry.key === key &&
    typeof entry.checksum === "string" &&
    KEY.test(entry.checksum) &&
    isTree(entry.tree)
  );
}

/** SHA-256 of a stored tree's JSON; parsing and re-serializing gives the same text for an untouched entry. */
function treeChecksum(tree: Root): string {
  return createHash("sha256").update(JSON.stringify(tree)).digest("hex");
}

/** A cache of parsed pages rooted at `dir`. Reads and writes never throw; a cache that fails only costs a parse. */
export function pageCache(dir: string, options: PageCacheOptions = {}): PageCache {
  const root = resolve(dir);
  const engine = options.engineVersion ?? version;
  const overridden = options.plugins;
  const overriddenImplementation = options.implementation;
  const overriddenInputs = options.implementationFiles;

  /**
   * The fingerprint of the implementation this run parses with, or `undefined` when it cannot be read and so cannot
   * be named. Folded into every key and checked against every entry.
   */
  async function currentImplementation(): Promise<string | undefined> {
    if (overriddenImplementation !== undefined) return overriddenImplementation;
    if (overriddenInputs !== undefined) {
      return fingerprintImplementation(overriddenInputs, implementationSources().root);
    }
    return builtInImplementationFingerprint();
  }

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
            // `null` is an implementation this run could not read: its own key, whose entries are never read.
            implementation: (await currentImplementation()) ?? null,
          }),
        )
        .digest("hex");
    },

    async get(key) {
      if (!KEY.test(key)) {
        options.onMiss?.("missing");
        return undefined;
      }
      const fingerprint = await currentImplementation();
      if (fingerprint === undefined) {
        // This run cannot say which parser code wrote an entry, so no entry is safe to read.
        options.onMiss?.("incompatible");
        return undefined;
      }
      let text: string;
      try {
        text = await readFile(join(root, `${key}.json`), "utf8");
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        options.onMiss?.(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "corrupt");
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        options.onMiss?.("corrupt");
        return undefined;
      }
      if (typeof parsed !== "object" || parsed === null) {
        options.onMiss?.("corrupt");
        return undefined;
      }
      const entry = parsed as Partial<PageCacheEntry>;
      if (entry.format !== PAGE_CACHE_FORMAT || entry.engine !== engine) {
        options.onMiss?.("incompatible");
        return undefined;
      }
      if (entry.implementation !== fingerprint) {
        // The tree was parsed by different parser or plugin code, which an unchanged package version would hide.
        options.onMiss?.("incompatible");
        return undefined;
      }
      if (!isEntry(parsed, key, engine, fingerprint) || parsed.checksum !== treeChecksum(parsed.tree)) {
        options.onMiss?.("corrupt");
        return undefined;
      }
      return parsed.tree;
    },

    async set(key, tree) {
      if (!KEY.test(key)) return;
      // An entry this run cannot describe is not worth keeping: the next build parses the page again.
      const fingerprint = await currentImplementation();
      if (fingerprint === undefined) return;
      let temp: string | undefined;
      try {
        await mkdir(root, { recursive: true });
        temp = await mkdtemp(join(root, ".tmp-"));
        const entry: PageCacheEntry = {
          format: PAGE_CACHE_FORMAT,
          engine,
          implementation: fingerprint,
          key,
          checksum: treeChecksum(tree),
          tree,
        };
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
