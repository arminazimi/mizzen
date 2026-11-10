import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The root file a host serves when a path is missing. */
const FILE = "404.html";

/** The file the HTML output gives a page whose pretty URL is `/404/`. */
const INSIDE = "404/index.html";

/**
 * Strips the site `base` from a page URL, along whole path segments only. Every URL the model carries includes
 * `base`, while the output folder is what deploys under `base` (GitHub Pages project sites), so the file path must
 * not repeat it. A URL that does not start with the base passes through untouched, as it does in the HTML output.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/**
 * The file a page URL names, relative to the output folder: a pretty URL (a trailing `/`, or no file name at all)
 * becomes `<url>/index.html`, and a URL that already names a file (`/404.html`) is written exactly. This mirrors
 * `indexPath` in `html.ts`, so the two outputs can never disagree about where a page goes.
 */
function filePath(url: string): string {
  const last = url.slice(url.lastIndexOf("/") + 1);
  const path = last.includes(".") ? url : `${url.endsWith("/") ? url : `${url}/`}index.html`;
  return path.replace(/^\//, "");
}

/** Escapes the characters that would end an HTML attribute or a text node early. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The site's 404 page: the doc page whose URL is `/404.html`, or the one whose pretty URL is `/404/`. */
interface MissingPage {
  readonly page: Page;
  /** True when the page's URL already names `404.html`, so the HTML output writes the same file. */
  readonly atRoot: boolean;
}

/**
 * Finds the page the site already has for a missing path, by the only name the engine knows it by: its URL. A page
 * whose URL is `/404.html` is written by the HTML output at the same file; a page whose URL is `/404/` is written
 * there inside a folder, so its document still has to reach the root. The first match in model order wins, and the
 * model is sorted by URL, so the choice is deterministic.
 */
function missingPage(site: Site): MissingPage | undefined {
  let inside: MissingPage | undefined;
  const base = site.config.base;
  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    const path = filePath(underBase(page.url, base));
    if (path === FILE) return { page, atRoot: true };
    if (path === INSIDE && inside === undefined) inside = { page, atRoot: false };
  }
  return inside;
}

/**
 * A complete document for a site that has no 404 page: the site's language and direction, a title and a short
 * message, and a root-relative link home. The link carries `base`, so the page works when a host serves it for a
 * path at any depth, and the document reads without a stylesheet or a script.
 */
function plainPage(site: Site): string {
  const lang = escapeHtml(site.config.lang);
  const dir = escapeHtml(site.config.dir);
  const home = escapeHtml(site.config.base === "" ? "/" : `${site.config.base}/`);
  return [
    "<!DOCTYPE html>",
    `<html lang="${lang}" dir="${dir}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Page not found</title>",
    "</head>",
    "<body>",
    "<h1>Page not found</h1>",
    "<p>The page you asked for does not exist or has moved.</p>",
    `<p><a href="${home}">Go to the home page</a></p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Writes `404.html` at the root of the output folder, the file GitHub Pages and other hosts serve for a missing
 * path.
 *
 * The site's 404 page, when the model has one, is rendered through `ctx.renderPage`, so its own layout supplies the
 * document: a page at `/404/` (a `404.md` without a permalink) moves to the root as `404.html`, and a page at
 * `/404.html` is left to the HTML output, which writes the same file, unless that output is switched off. Without
 * such a page, the output writes a plain document with a root-relative link home. No diagnostic is reported: a site
 * that has no themed 404 page still gets one, and an output never fails a build for a config or content choice.
 */
export const notFound: Output = {
  name: "not-found",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const found = missingPage(site);
    if (found === undefined) return [{ path: FILE, contents: plainPage(site) }];
    if (found.atRoot && site.config.outputs.html !== false) return [];
    return [{ path: FILE, contents: await ctx.renderPage(found.page) }];
  },
};
