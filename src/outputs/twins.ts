import type { Page, Site } from "../contracts/content.ts";
import type { LinkTag } from "../contracts/render.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { isAppPage } from "./app-pages.ts";

/** Compares by code point, never by locale (ADR 0022, rule 5). */
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

/**
 * The Markdown twin of a page URL (ADR 0006): the same address with `.md` in place of the HTML file, so a pretty URL
 * (`/guide/install/`) gives `/guide/install/index.md`, the site root gives `/index.md`, and `/404.html` gives `/404.md`.
 * Mirrors the file the HTML output writes. Returns undefined for a URL that names a file other than HTML, which has
 * no twin.
 */
export function twinUrl(url: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".md")}`;
  if (last.includes(".")) return undefined;
  return `${url.endsWith("/") ? url : `${url}/`}index.md`;
}

/**
 * The head link that advertises a page's Markdown twin (ADR 0006, decision 6): `rel=alternate type=text/markdown` at
 * the twin's site-relative address, which already carries `base`. A page with no twin has no link: an app page, an
 * asset, or a doc page whose URL names a file other than HTML. A layout adds it to the `Head` data it prints.
 */
export function twinLink(page: Page): LinkTag | undefined {
  if (page.kind !== "doc") return undefined;
  const href = twinUrl(page.url);
  if (href === undefined) return undefined;
  return { rel: "alternate", href, attrs: { type: "text/markdown" } };
}

/**
 * Writes each doc page's Markdown twin at `<url>/index.md` next to its HTML (ADR 0006): the page's source Markdown
 * with the front matter removed and directives kept readable, the same text `llms-full.txt` carries for the page.
 * The site root becomes `index.md`, and a URL that already names an HTML file (`/404.html`) becomes its `.md` name.
 *
 * App pages are skipped, since a twin would copy a program rather than a document, and so is a doc page whose URL
 * names a file other than HTML, because that file has no Markdown twin. The site `base` is stripped from the path,
 * as the HTML output strips it, so a project site writes `guide/install/index.md` into the output folder. Files come
 * back sorted by path (ADR 0022, rule 5), whatever order the model had.
 */
export const twins: Output = {
  name: "twins",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const options = { pages: site.pages };
    const files: OutputFile[] = [];
    for (const page of site.pages) {
      if (page.kind !== "doc" || isAppPage(page.url, options)) continue;
      const url = twinUrl(page.url);
      if (url === undefined) continue;
      files.push({ path: underBase(url, site.config.base).replace(/^\//, ""), contents: page.markdown });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
