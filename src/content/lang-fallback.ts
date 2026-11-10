import type { Page, Site, SiteConfig } from "../contracts/index.ts";

/**
 * The pages that can stand in for one another, and the order a missing language falls back in.
 *
 * The fallback chain lives in `_data/languages.yml`, never in `mizzen.yml`: the site config schema is frozen
 * and has no `fallback` key. The file holds a single mapping:
 *
 * ```yaml
 * fallback:
 *   - fa
 *   - en
 * ```
 *
 * Without that file, or without a usable `fallback` list in it, the chain is the site's default language.
 * `fallbackChain` reads it; `resolveLanguage` uses it when the caller passes no chain.
 */

/** A page as the language helpers read it: no rendered body or headings needed. */
export type LanguagePage = Pick<Page, "url" | "lang" | "frontMatter">;

/** The site settings `translationId` reads to undo the URL shape a language adds. */
export type TranslationIdConfig = Pick<SiteConfig, "base" | "languages">;

/** What `resolveLanguage` found: the page to show, its language, and whether it is a fallback. */
export interface LanguageResolution {
  /** The page to render for the requested translation. */
  readonly page: Page;
  /** The resolved page's language, a BCP 47 tag as the page carries it. */
  readonly lang: string;
  /** `true` when the page is not in the requested language, but a less specific tag or the fallback chain. */
  readonly fallback: boolean;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A URL or prefix as its non-empty path segments: `/fa/guide/` → `["fa", "guide"]`. */
function pathSegments(path: string): readonly string[] {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** `true` when `segments` starts with every segment of `prefix`. */
function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, i) => segments[i] === part);
}

/** Turn path segments back into a `/`-rooted URL with a trailing slash, as page URLs have. */
function asUrl(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

/**
 * The page's identity across translations: its non-empty `translation_key`, else its URL with the site `base`
 * and the page's language prefix removed. `/docs/fa/guides/install/` becomes `/guides/install/`, so the
 * English page at `/docs/guides/install/` and the Persian one share an identity. When several configured
 * prefixes match, the longest one wins, so `/docs/ja-jp/` is not split at `/ja`.
 */
export function translationId(page: LanguagePage, config: TranslationIdConfig): string {
  const key = page.frontMatter.translation_key;
  if (typeof key === "string" && key.trim() !== "") return key.trim();

  let segments = pathSegments(page.url);

  const base = pathSegments(config.base);
  if (base.length > 0 && startsWithSegments(segments, base)) segments = segments.slice(base.length);

  const prefixes = config.languages
    .map((language) => pathSegments(language.prefix))
    .filter((prefix) => prefix.length > 0)
    .sort((a, b) => b.length - a.length || byCodePoint(a.join("/"), b.join("/")));

  const prefix = prefixes.find((candidate) => startsWithSegments(segments, candidate));
  if (prefix !== undefined) segments = segments.slice(prefix.length);

  return asUrl(segments);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The languages to try, in order, when a page is missing: `_data/languages.yml`'s `fallback` list when it
 * provides one, else `[config.lang]`.
 *
 * An explicit empty list means "never fall back", and is kept as `[]`; entries that are not non-empty strings
 * are ignored, and a list with no usable entry is treated as missing.
 */
export function fallbackChain(
  config: Pick<SiteConfig, "lang">,
  data: Readonly<Record<string, unknown>>,
): readonly string[] {
  const languages: unknown = data["languages"];
  if (isMapping(languages)) {
    const fallback = languages["fallback"];
    if (Array.isArray(fallback)) {
      const chain = fallback
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      if (fallback.length === 0 || chain.length > 0) return chain;
    }
  }
  return [config.lang];
}

/** A language tag in the form matching compares: trimmed, lower case, `_` read as `-`. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** The tag and each shorter form: `pt-BR-x` → `["pt-br-x", "pt-br", "pt"]`. */
function tagChain(tag: string): readonly string[] {
  const parts = normalizeTag(tag).split("-").filter((part) => part !== "");
  const chain: string[] = [];
  for (let length = parts.length; length > 0; length--) chain.push(parts.slice(0, length).join("-"));
  return chain;
}

/** The first page in `group` whose language is exactly `tag`, compared case-insensitively. */
function findTag(group: readonly Page[], tag: string): Page | undefined {
  const wanted = normalizeTag(tag);
  return group.find((page) => normalizeTag(page.lang) === wanted);
}

/**
 * Choose the page to show for `page`'s translation: the page whose language is exactly `page.lang`, then a
 * page in a shorter form of the same tag (`pt-BR` falls back to `pt`), then the first language in `chain`
 * (default: `fallbackChain(site.config, site.data)`) that has a page. Returns `undefined` when the
 * translation has no page at all.
 *
 * `page` may be a page of `site`, or a stand-in for a missing translation: its `translation_key` or URL
 * identifies the group, and its `lang` is the language wanted.
 */
export function resolveLanguage(
  site: Site,
  page: LanguagePage,
  chain?: readonly string[],
): LanguageResolution | undefined {
  const group = languageGroups(site).get(translationId(page, site.config));
  if (group === undefined || group.length === 0) return undefined;

  for (const tag of tagChain(page.lang)) {
    const found = findTag(group, tag);
    if (found !== undefined) {
      return { page: found, lang: found.lang, fallback: tag !== normalizeTag(page.lang) };
    }
  }

  const fallbacks = chain ?? fallbackChain(site.config, site.data);
  for (const language of fallbacks) {
    for (const tag of tagChain(language)) {
      const found = findTag(group, tag);
      if (found !== undefined) return { page: found, lang: found.lang, fallback: true };
    }
  }

  return undefined;
}

/**
 * Every page grouped by `translationId`, so a page and its translations share a key. Each group is sorted by
 * language code, then by URL to keep duplicates of one language deterministic; the groups themselves are in
 * the order of their first page by URL, so the map is stable whatever order `site.pages` arrives in.
 */
export function languageGroups(site: Site): ReadonlyMap<string, readonly Page[]> {
  const groups = new Map<string, Page[]>();
  const pages = [...site.pages].sort((a, b) => byCodePoint(a.url, b.url));

  for (const page of pages) {
    const id = translationId(page, site.config);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [page]);
    else group.push(page);
  }

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        byCodePoint(a.lang.toLowerCase(), b.lang.toLowerCase()) ||
        byCodePoint(a.lang, b.lang) ||
        byCodePoint(a.url, b.url),
    );
  }

  return groups;
}
