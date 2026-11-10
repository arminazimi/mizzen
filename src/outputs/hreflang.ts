import type { Page, Site } from "../contracts/content.ts";
import type { LinkTag } from "../contracts/render.ts";
import { languageGroups, translationId } from "../content/lang-fallback.ts";

/** A language tag as matching compares it: trimmed, lower case, `_` read as `-`. */
function tagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * The address a link points at: the page URL made absolute with the site `url` when the site has one, else the
 * site-relative URL the model carries (which already includes `base`).
 */
function hrefOf(site: Site, page: Page): string {
  const origin = site.config.url?.replace(/\/$/, "");
  if (origin === undefined || origin === "" || !page.url.startsWith("/")) return page.url;
  return `${origin}${page.url}`;
}

/**
 * The `hreflang` alternates of a page: one `rel=alternate` link per language its translation group has, the page's
 * own language included, plus an `x-default` link at the default-language page when the group has one. A page whose
 * group has only one language gets no links, and so does a page that is not in the model.
 *
 * Grouping is the one N37 gives translation (`translationId` over `site.pages`: an explicit `translation_key`, else
 * the URL with `base` and the language prefix removed). Languages come in code-point order, with `x-default` last,
 * and one page stands for a language when a group holds more than one, so the same model always gives the same links.
 * The href is absolute when the site has a `url`, else the page URL as the model carries it.
 */
export function hreflangLinks(site: Site, page: Page): LinkTag[] {
  const group = languageGroups(site).get(translationId(page, site.config));
  if (group === undefined) return [];

  const byLanguage = new Map<string, Page>();
  for (const member of group) {
    const key = tagKey(member.lang);
    if (!byLanguage.has(key)) byLanguage.set(key, member);
  }
  if (byLanguage.size < 2) return [];

  const links: LinkTag[] = [...byLanguage.values()].map((member) => ({
    rel: "alternate",
    href: hrefOf(site, member),
    attrs: { hreflang: member.lang },
  }));

  const fallback = byLanguage.get(tagKey(site.config.lang));
  if (fallback !== undefined) {
    links.push({ rel: "alternate", href: hrefOf(site, fallback), attrs: { hreflang: "x-default" } });
  }
  return links;
}
