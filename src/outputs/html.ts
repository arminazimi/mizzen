import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strips the site `base` from a page URL, along whole path segments only. Every URL the model carries includes
 * `base`, while the output folder is what deploys under `base` (GitHub Pages project sites), so the file path must
 * not repeat it. A URL that does not start with the base (which the model never makes) passes through untouched.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** The file a page writes, relative to the output folder, so the leading `/` goes. A pretty URL (a trailing
 * `/`, or no file name at all) becomes `<url>/index.html`; a URL that already names a file, such as the
 * `permalink: /404.html` of a 404 page, is written exactly as it is. */
function indexPath(url: string): string {
  const last = url.slice(url.lastIndexOf("/") + 1);
  let path = last.includes(".") ? url : `${url.endsWith("/") ? url : `${url}/`}index.html`;
  return path.replace(/^\//, "");
}

/**
 * Writes every doc page's rendered HTML to the file its URL names: a pretty URL (`/guide/install/`) becomes
 * `<url>/index.html`, the site root becomes `index.html`, and a URL that already names a file (`/404.html`,
 * the page a host serves when a path is missing) is written exactly, so hosts serve the pretty URLs.
 *
 * App pages are skipped: discovery marks a whole app folder one kind, so the model lists only the folder's root
 * page with `kind: "app"`, and its files pass through `copyAssets` untouched. Assets are files, not pages, and
 * never enter the model's page list. Files come back sorted by path, whatever order the model
 * had.
 */
export const html: Output = {
  name: "html",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const base = site.config.base;
    const files: OutputFile[] = [];
    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      const path = indexPath(underBase(page.url, base));
      files.push({ path, contents: await ctx.renderPage(page) });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
