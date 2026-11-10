import * as pagefind from "pagefind";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The folder the index lands in, relative to the output folder; the search client loads `/pagefind/pagefind.js`. */
const FOLDER = "pagefind";

/** The section a page that sits at the site root belongs to, like `llms.ts` does for links outside a group. */
const ROOT_SECTION = "Pages";

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strips the site `base` from a page URL, along whole path segments only. Every URL the model carries includes
 * `base`, while the output folder is what deploys under `base` (GitHub Pages project sites), so the section must
 * not repeat it. A URL that does not start with the base (which the model never makes) passes through untouched.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/**
 * The page's section, as the first folder of its URL below `base`: `/rules/cache-017/` is `rules`, a page directly
 * under `base` is `Pages`, and a URL that names a file (`/404.html`) belongs to the folder above it. The value is
 * a URL segment, so it matches the navigation's paths and needs no theme or navigation lookup.
 */
function sectionOf(url: string, base: string): string {
  const segments = underBase(url, base)
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length > 0 && segments.at(-1)!.includes(".")) segments.pop();
  return segments[0] ?? ROOT_SECTION;
}

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The document Pagefind reads for one page: the model's rendered body inside the `data-pagefind-body` element, so
 * the theme's chrome never enters the index, plus the title as metadata and the section as a filter for the result
 * list. The language comes from the page, so Pagefind splits `fa` pages into their own index. Rendering the page
 * again through the theme would repeat its layout diagnostics, so the model's already-rendered body is used.
 */
function documentOf(page: Page, section: string): string {
  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeAttribute(page.lang)}" dir="${page.dir}">`,
    "<head>",
    `<meta data-pagefind-meta="title[content]" content="${escapeAttribute(page.title)}">`,
    `<meta data-pagefind-filter="section[content]" content="${escapeAttribute(section)}">`,
    "</head>",
    `<body><article data-pagefind-body>${page.html}</article></body>`,
    "</html>",
  ].join("");
}

/** Reports Pagefind's error strings as diagnostics, so a build never fails silently when indexing breaks. */
function reportErrors(ctx: OutputContext, page: Page | undefined, errors: readonly string[]): void {
  for (const message of errors) {
    ctx.report({
      id: "search.index-failed",
      severity: "error",
      message: page === undefined ? `Pagefind could not build the search index: ${message}` : `Pagefind could not index ${page.url}: ${message}`,
      ...(page === undefined ? {} : { pos: page.source }),
      help: "Check the page's HTML and the Pagefind version, then run the build again.",
    });
  }
}

/**
 * Writes a Pagefind index to `pagefind/`: one record per doc page, taken from the page's rendered HTML, so
 * `data-pagefind-body` keeps chrome out and Pagefind's language detection gives `fa` pages their own index. Each
 * record carries the page title as metadata and its first URL folder as a `section` filter, which the search dialog
 * groups results by. A page with `search: false` in its front matter is left out, and `search: false` in the site
 * config writes no index at all.
 *
 * Pagefind writes to disk, so the index is built and read back in memory as the output contract asks; files come
 * back under `pagefind/`, sorted by path (ADR 0022, rule 5). Pagefind errors are diagnostics, not throws.
 */
export const search: Output = {
  name: "search",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.search === false) return [];

    const pages = site.pages.filter((p) => p.kind === "doc" && p.frontMatter.search !== false);
    if (pages.length === 0) return [];

    const created = await pagefind.createIndex();
    if (created.index === undefined) {
      reportErrors(ctx, undefined, created.errors);
      await pagefind.close();
      return [];
    }

    try {
      const index = created.index;
      for (const page of pages) {
        const content = documentOf(page, sectionOf(page.url, site.config.base));
        const added = await index.addHTMLFile({ url: page.url, content });
        reportErrors(ctx, page, added.errors);
      }

      const { files, errors } = await index.getFiles();
      reportErrors(ctx, undefined, errors);
      return files
        .map((file) => ({ path: `${FOLDER}/${file.path}`, contents: file.content }))
        .sort((a, b) => byCodePoint(a.path, b.path));
    } finally {
      await pagefind.close();
    }
  },
};
