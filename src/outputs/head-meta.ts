import type { Page, Site } from "../contracts/content.ts";
import type { Trail } from "../contracts/nav.ts";
import type { Head, LinkTag, MetaTag } from "../contracts/render.ts";

/**
 * Computes each page's {@link Head} once, so layouts only print it. This unit writes no file: the render step calls
 * {@link headMeta} for every page and hands the result to the layout.
 *
 * Rules (front matter keys from `schema/front-matter/base.schema.json`):
 * - `canonical_url` from front matter wins over the page's own URL; a canonical needs `config.url`, so without it
 *   there is no canonical link.
 * - `description` from front matter wins; the home page falls back to the site `description`.
 * - `image` from front matter is the social image; it needs `config.url` to become absolute.
 * - `og: false` drops the Open Graph and Twitter card tags and the image in the structured data; the canonical link
 *   and the description stay.
 * - Structured data: the home page is a `WebSite`, every other page a `TechArticle` (publisher: the site title), and a
 *   page with a breadcrumb trail adds a `BreadcrumbList`.
 */

/** The separator between a page's title and the site title in the document title. */
const TITLE_SEPARATOR = " | ";

/** Returns the value when it is a string with text in it, else `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Makes a URL absolute: an `http(s)` URL is kept, and a path starting with `/` gets the site `url` in front. Anything
 * else, or a path with no site `url` to use, has no absolute form and returns `undefined`.
 */
function absolute(site: Site, value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) return value;
  const origin = site.config.url?.replace(/\/$/, "");
  if (origin === undefined || origin === "" || !value.startsWith("/")) return undefined;
  return `${origin}${value}`;
}

/** True for the home page, whose URL is the site `base` followed by a slash. */
function isHome(site: Site, page: Page): boolean {
  return page.url === `${site.config.base}/`;
}

/** The breadcrumb as a schema.org `BreadcrumbList`, one `ListItem` per link of the trail, in order. */
function breadcrumbList(site: Site, trail: Trail): Readonly<Record<string, unknown>> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((link, index) => {
      const item = absolute(site, link.url);
      return {
        "@type": "ListItem",
        position: index + 1,
        name: link.title,
        ...(item === undefined ? {} : { item }),
      };
    }),
  };
}

/**
 * Computes the `<head>` of one page: the document title, its meta and link tags, and its JSON-LD objects.
 *
 * @param site The whole site model, for the site title, base, URL, and description.
 * @param page The page the head is for.
 * @param trail The page's breadcrumb from the navigation, the page itself last; empty when the page is not listed.
 */
export function headMeta(site: Site, page: Page, trail: Trail): Head {
  const home = isHome(site, page);
  const siteTitle = site.config.title;
  const pageName = home ? siteTitle : page.title;
  const title = home ? siteTitle : `${page.title}${TITLE_SEPARATOR}${siteTitle}`;

  const description = text(page.frontMatter.description) ?? (home ? text(site.config.description) : undefined);
  const canonicalSource = text(page.frontMatter.canonical_url);
  const canonical = canonicalSource === undefined ? absolute(site, page.url) : absolute(site, canonicalSource);
  const social = page.frontMatter.og !== false;

  const imageValue = text(page.frontMatter.image);
  const image = social && imageValue !== undefined ? absolute(site, imageValue) : undefined;

  const meta: MetaTag[] = [];
  if (description !== undefined) meta.push({ name: "description", content: description });
  if (social) {
    meta.push({ name: "og:type", content: home ? "website" : "article", property: true });
    meta.push({ name: "og:title", content: pageName, property: true });
    if (description !== undefined) meta.push({ name: "og:description", content: description, property: true });
    if (canonical !== undefined) meta.push({ name: "og:url", content: canonical, property: true });
    meta.push({ name: "og:site_name", content: siteTitle, property: true });
    if (image !== undefined) meta.push({ name: "og:image", content: image, property: true });
    meta.push({ name: "twitter:card", content: image === undefined ? "summary" : "summary_large_image" });
  }

  const links: LinkTag[] = canonical === undefined ? [] : [{ rel: "canonical", href: canonical }];

  const structured: Record<string, unknown> = {
    "@context": "https://schema.org",
    inLanguage: page.lang,
    ...(description === undefined ? {} : { description }),
    ...(canonical === undefined ? {} : { url: canonical }),
    ...(image === undefined ? {} : { image }),
  };
  const jsonLd: Readonly<Record<string, unknown>>[] = home
    ? [{ ...structured, "@type": "WebSite", name: siteTitle }]
    : [
        {
          ...structured,
          "@type": "TechArticle",
          headline: pageName,
          publisher: { "@type": "Organization", name: siteTitle },
        },
      ];
  if (trail.length > 0) jsonLd.push(breadcrumbList(site, trail));

  return { title, meta, links, jsonLd };
}
