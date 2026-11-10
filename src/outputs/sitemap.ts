import type { SiteConfig } from "../contracts/config.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { languageGroups, translationId } from "../content/lang-fallback.ts";
import { isAppPage } from "./app-pages.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escapes the five characters XML reserves, so any URL can sit inside `<loc>`. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The scheme and host the sitemap's absolute URLs start with, from `url` in the site config. Without a valid `url`
 * the sitemap cannot be written, so the output reports a warning and returns `undefined`.
 */
function originOf(site: Site, ctx: OutputContext): string | undefined {
  const url = site.config.url?.trim() ?? "";
  const help = "Set `url` in the site config to the published scheme and host, such as `https://arminazimi.github.io`.";
  if (url === "") {
    ctx.report({
      id: "sitemap.no-url",
      severity: "warning",
      message: "sitemap.xml is not written: the site config has no `url`, and a sitemap needs absolute URLs.",
      help,
    });
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    ctx.report({
      id: "sitemap.invalid-url",
      severity: "warning",
      message: `sitemap.xml is not written: the site config's \`url\` (${url}) is not an absolute URL.`,
      help,
    });
    return undefined;
  }
}

/**
 * The page's `lastmod`, from its `updated` front matter, as `YYYY-MM-DD` (a date the sitemap protocol accepts). A
 * time and an offset after the date are dropped. A value that is not a real calendar date is left out, not guessed,
 * and so is a page that sets no `updated`.
 */
function lastmod(page: Page): string | undefined {
  const value = page.frontMatter.updated;
  if (typeof value !== "string") return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  if (!match) return undefined;
  const date = match[0];
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return undefined;
  return date;
}

/**
 * A language tag as N37's `languageGroups` compares it: trimmed, lower case, `_` read as `-`.
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** The tag and each shorter form: `pt-BR-x` → `["pt-br-x", "pt-br", "pt"]` (N37's `tagChain`). */
function tagChain(tag: string): readonly string[] {
  const parts = normalizeTag(tag).split("-").filter((part) => part !== "");
  const chain: string[] = [];
  for (let length = parts.length; length > 0; length--) chain.push(parts.slice(0, length).join("-"));
  return chain;
}

/** One alternate of a page: a language and the URL that serves it. */
interface Alternate {
  readonly lang: string;
  readonly url: string;
}

/**
 * The alternates of one page: every sitemap page in its language group (N37's `languageGroups`), one per language,
 * in the group's order (by language tag), then `x-default` pointing at the default language's page, or at the
 * group's first page when the default language has none. A language that no listed page serves is left out.
 *
 * Returns `undefined` when the group holds one language in the sitemap, so a single-language site writes the
 * sitemap it always has.
 */
function alternatesOf(
  page: Page,
  config: SiteConfig,
  groups: ReadonlyMap<string, readonly Page[]>,
  listed: ReadonlySet<string>,
): readonly Alternate[] | undefined {
  const group = groups.get(translationId(page, config));
  if (group === undefined) return undefined;

  const languages = new Set<string>();
  const alternates: Alternate[] = [];
  for (const entry of group) {
    const tag = normalizeTag(entry.lang);
    if (tag === "" || languages.has(tag) || !listed.has(entry.url)) continue;
    languages.add(tag);
    alternates.push({ lang: entry.lang, url: entry.url });
  }
  if (alternates.length < 2) return undefined;

  const defaultTags = tagChain(config.lang);
  const xDefault = alternates.find((alternate) => defaultTags.includes(normalizeTag(alternate.lang))) ?? alternates[0];
  if (xDefault === undefined) return undefined;
  return [...alternates, { lang: "x-default", url: xDefault.url }];
}

/**
 * Writes `sitemap.xml`: one `<url>` per doc page, with the absolute URL (the config's `url` plus the page's URL, which
 * already carries `base`) and `lastmod` when the page sets `updated`. A page with `sitemap: false` is left out, and so
 * is every app page, because the config has no key that lists one (the frozen config schema decides that).
 *
 * A page that has translations gets one `<xhtml:link rel="alternate">` per language of its group plus `x-default`,
 * and the document declares the XHTML namespace only when some page has alternates; a single-language site writes
 * exactly the bytes it wrote before. Entries come back sorted by URL. A site without a valid
 * `url` gets no file and a warning, and `url` is what makes every `href` absolute, as the protocol requires.
 */
export const sitemap: Output = {
  name: "sitemap",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const origin = originOf(site, ctx);
    if (origin === undefined) return [];

    const pages = site.pages
      .filter((p) => p.kind === "doc" && p.frontMatter.sitemap !== false && !isAppPage(p.url, { pages: site.pages }))
      .sort((a, b) => byCodePoint(a.url, b.url));

    const groups = languageGroups(site);
    const listed = new Set(pages.map((p) => p.url));
    const entries = pages.map((p) => ({ page: p, alternates: alternatesOf(p, site.config, groups, listed) }));
    const hasAlternates = entries.some((entry) => entry.alternates !== undefined);

    const urls = entries.map(({ page, alternates }) => {
      const loc = escapeXml(new URL(page.url, origin).href);
      const date = lastmod(page);
      return [
        "  <url>",
        `    <loc>${loc}</loc>`,
        ...(date === undefined ? [] : [`    <lastmod>${date}</lastmod>`]),
        ...(alternates ?? []).map((alternate) => {
          const href = escapeXml(new URL(alternate.url, origin).href);
          return `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.lang)}" href="${href}"/>`;
        }),
        "  </url>",
      ].join("\n");
    });

    const xmlns = [
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      ...(hasAlternates ? ['xmlns:xhtml="http://www.w3.org/1999/xhtml"'] : []),
    ].join(" ");

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<urlset ${xmlns}>`,
      ...urls,
      "</urlset>",
      "",
    ].join("\n");

    return [{ path: "sitemap.xml", contents: xml }];
  },
};
