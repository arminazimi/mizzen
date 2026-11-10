import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix as path, join } from "node:path";
import { themeAssetPath } from "../pipeline/assets.ts";
import { transform } from "lightningcss";
import type { Targets } from "lightningcss";

/** One minified CSS file the engine writes to the output folder. */
export interface CssBundle {
  /** Path relative to the output folder, using `/`: `assets/theme/<kind>-<hash>.css`. */
  readonly path: string;
  /** Minified CSS text. */
  readonly css: string;
  /** SHA-256 of `css`, as 16 lowercase hex characters. */
  readonly hash: string;
}

/** The CSS one page loads: the shared base bundle, and the bundle for the units that page used. */
export interface PageCss {
  /** Shared by every page of the site; written once. */
  readonly base: CssBundle;
  /** Bundle of the `style.css` files of the units on this page; `undefined` when it used none. */
  readonly page: CssBundle | undefined;
}

export interface CssBundlerOptions {
  /** Absolute path of the theme's root folder; the paths below are relative to it. */
  readonly themeRoot: string;
  /** Shared base stylesheets, in cascade order. Every page loads them. */
  readonly base: readonly string[];
  /** Browsers to lower the CSS for. Unset keeps modern syntax, including logical properties. */
  readonly targets?: Targets;
  /** The site's base path (`/slipway`, or `""`); `url()` references to theme files are rewritten to start with it. */
  readonly urlBase?: string;
}

/** Bundles base and per-page CSS. Create one per build so the cache lives as long as the build. */
export interface CssBundler {
  /**
   * Returns the base bundle and the bundle for `used`, the unit CSS paths the render stage reports
   * (`RenderResult.css`). Paths are sorted before bundling, so the same units always give the same bundle.
   */
  page(used: readonly string[]): Promise<PageCss>;
  /**
   * Theme files (relative to the theme root, sorted) that bundled CSS refers to with `url()`, such as fonts.
   * The caller copies them with `themeFiles`, which gives them the hashed names the bundles point at.
   */
  assets(): readonly string[];
}

/** Folder under the output that bundled CSS goes to, shared with hashed theme assets. */
const THEME_OUT = "assets/theme";

/** Length of the hash in a file name: 16 hex characters is far beyond collision range for a site. */
const HASH_LENGTH = 16;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Minifies each file with Lightning CSS and joins the results in the order given. Files are minified
 * one at a time so the cascade order is the order of the list, and a file cannot change another's output.
 */
function minify(
  paths: readonly string[],
  sources: readonly string[],
  targets: Targets | undefined,
  url: (from: string, ref: string) => string,
): string {
  return paths
    .map((rel, i) => {
      const out = transform({
        filename: rel,
        code: Buffer.from(sources[i] ?? ""),
        minify: true,
        visitor: { Url: (u) => ({ ...u, url: url(rel, u.url) }) },
        ...(targets !== undefined ? { targets } : {}),
      });
      return Buffer.from(out.code).toString("utf8");
    })
    .join("\n");
}

function bundle(kind: string, css: string): CssBundle {
  const hash = hashOf(css);
  return { path: `${THEME_OUT}/${kind}-${hash}.css`, css, hash };
}

/**
 * Creates a bundler for one build. Each distinct set of files is minified once and then served from
 * the cache. The cache key is the paths plus the bytes of their files, so a changed stylesheet makes
 * a new bundle and an unchanged one is never minified twice.
 */
export function createCssBundler(options: CssBundlerOptions): CssBundler {
  const { themeRoot, base, targets } = options;
  const urlBase = options.urlBase ?? "";
  const cache = new Map<string, CssBundle>();
  const referenced = new Set<string>();

  /** Points a relative `url()` at the theme file's hashed copy; anything else is left as written. */
  function rewrite(from: string, ref: string): string {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return ref;
    const target = path.normalize(path.join(path.dirname(from), ref.split(/[?#]/)[0] ?? ""));
    if (target.startsWith("..")) return ref;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(themeRoot, target));
    } catch {
      return ref;
    }
    referenced.add(target);
    return `${urlBase}/${themeAssetPath(target, bytes)}`;
  }

  async function cached(kind: string, paths: readonly string[]): Promise<CssBundle> {
    const sources = await Promise.all(paths.map((rel) => readFile(join(themeRoot, rel), "utf8")));
    const key = createHash("sha256").update(JSON.stringify([kind, paths, sources])).digest("hex");
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const made = bundle(kind, minify(paths, sources, targets, rewrite));
    cache.set(key, made);
    return made;
  }

  return {
    assets: () => [...referenced].sort(byCodePoint),
    async page(used) {
      const units = [...new Set(used)].sort(byCodePoint);
      const [baseOut, pageOut] = await Promise.all([
        cached("base", base),
        units.length === 0 ? undefined : cached("page", units),
      ]);
      return { base: baseOut, page: pageOut };
    },
  };
}
