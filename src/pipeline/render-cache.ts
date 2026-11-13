/**
 * The per-page render cache: the HTML a page's layout produced, so a body-only edit re-renders only the page that
 * changed. It is separate from the whole-build cache (which answers "is anything different at all?") and from the page
 * cache (which answers "does this Markdown need parsing again?").
 *
 * An entry is only usable under a {@link renderSettingsKey} that covers the config, navigation, data, theme, outputs,
 * and every page's front matter. Within one settings key, a page's own model is the only other input, so a page whose
 * body did not change is rendered identically and can be read from disk. An entry is written atomically and checked
 * before use: a missing, corrupt, oversized, or foreign-format file is a miss, never bad output. A cache that cannot be
 * read or written leaves the build to render the page, exactly as before.
 *
 * Entries live under `<cache>/render/<settings-key>/<page-key>.json`, so changing the settings retires every entry by
 * construction; the next successful build prunes the retired folders.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, Page } from "../contracts/index.ts";

/** Bumped when the meaning of an entry changes, so an entry written by an older engine is never trusted. */
export const RENDER_CACHE_FORMAT = 1;

/** The largest entry read or written; a page's HTML is far below this, and a larger file is not ours. */
export const MAX_RENDER_ENTRY_BYTES = 8 * 1024 * 1024;

/** What one page's render produced, without the CSS links the build adds afterwards. */
export interface RenderCacheEntry {
  readonly html: string;
  readonly css: readonly string[];
  readonly islands?: readonly { readonly src: string }[] | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A page's identity inside one settings key: its whole model, layout included. `evidence` is the trust and drift
 * evidence the theme reads for this page, which can move with git and with quoted source positions; it is per page so
 * a body edit elsewhere does not retire this page.
 */
export function renderPageKey(
  settings: string,
  page: Page,
  defaultLayout: string | undefined,
  evidence = "",
): string {
  const hash = createHash("sha256");
  hash.update(`mizzen-render-page\0${RENDER_CACHE_FORMAT}\0${settings}\0${defaultLayout ?? ""}\0${evidence}\0`);
  hash.update(JSON.stringify(page));
  return hash.digest("hex");
}

/** The cache of one settings key. */
export interface RenderCache {
  /** The entry for `key`, or `undefined` when there is none or it cannot be trusted. */
  get(key: string): Promise<RenderCacheEntry | undefined>;
  /** Writes the entry atomically; a write that fails is ignored. */
  set(key: string, entry: RenderCacheEntry): Promise<void>;
}

/** True when `value` has the shape this version writes. */
function isEntry(value: unknown): value is RenderCacheEntry & { readonly version: number } {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<RenderCacheEntry & { version: unknown }>;
  return (
    entry.version === RENDER_CACHE_FORMAT &&
    typeof entry.html === "string" &&
    Array.isArray(entry.css) &&
    entry.css.every((file): file is string => typeof file === "string") &&
    (entry.islands === undefined ||
      (Array.isArray(entry.islands) &&
        entry.islands.every((island) => typeof (island as { src?: unknown }).src === "string"))) &&
    Array.isArray(entry.diagnostics)
  );
}

/** The render cache under one settings folder. */
export function renderCache(dir: string): RenderCache {
  return {
    async get(key) {
      if (!/^[0-9a-f]{64}$/.test(key)) return undefined;
      try {
        const text = await readFile(join(dir, `${key}.json`), "utf8");
        if (text.length > MAX_RENDER_ENTRY_BYTES) return undefined;
        const parsed: unknown = JSON.parse(text);
        if (!isEntry(parsed)) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    },
    async set(key, entry) {
      try {
        const text = JSON.stringify({ version: RENDER_CACHE_FORMAT, ...entry });
        if (text.length > MAX_RENDER_ENTRY_BYTES) return;
        await mkdir(dir, { recursive: true });
        const staging = join(dir, `.${key}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
        await writeFile(staging, text);
        await rename(staging, join(dir, `${key}.json`));
      } catch {
        // A cache that cannot be written is not a build failure: the page was rendered and is written either way.
      }
    },
  };
}

/** Removes every settings folder under `root` except `keep`, so retired entries do not grow without bound. */
export async function pruneRenderCache(root: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keep) continue;
    await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The include-file hashes of one build, so the next build can name the snippet a page change came from. */
export type RenderInputs = Readonly<Record<string, string>>;

/** The previous build's include hashes under one settings folder, or none. */
export async function readRenderInputs(dir: string): Promise<RenderInputs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "inputs.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const inputs: Record<string, string> = {};
    for (const [path, digest] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) inputs[path] = digest;
    }
    return inputs;
  } catch {
    return {};
  }
}

/** Records this build's include hashes; a failed write only costs the next build a less precise explanation. */
export async function writeRenderInputs(dir: string, inputs: RenderInputs): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "inputs.json"), JSON.stringify(inputs));
  } catch {
    // Explanation only: the rendered output is already correct without it.
  }
}
