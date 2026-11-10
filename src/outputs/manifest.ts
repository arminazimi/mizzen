import { createHash } from "node:crypto";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { twinUrl } from "./twins.ts";

/** Where the manifest lands, relative to the output folder. */
const FILE = ".mizzen/manifest.json";

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the text, as 64 lowercase hex characters. The manifest schema checks the same form. */
function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Strips the site `base` from a page URL, along whole path segments only. Mirrors the HTML output: every URL the
 * model carries includes `base`, while the output folder is what deploys under `base` (GitHub Pages project sites),
 * so the file path must not repeat it.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/**
 * The file a page writes, relative to the output folder, so the leading `/` goes: a pretty URL (a trailing `/`, or
 * no file name at all) becomes `<url>/index.html`, and a URL that names a file, such as `permalink: /404.html`, is
 * kept as it is. Mirrors the HTML output, and the manifest and the file it names must agree.
 */
function indexPath(url: string): string {
  const last = url.slice(url.lastIndexOf("/") + 1);
  const path = last.includes(".") ? url : `${url.endsWith("/") ? url : `${url}/`}index.html`;
  return path.replace(/^\//, "");
}

/** One page entry: what tools need to read or check a built page without guessing. */
interface ManifestPage {
  /** Output URL, including `base`. */
  readonly url: string;
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
  /** The page's title as the build resolved it. */
  readonly title: string;
  /** The layout from front matter (after `defaults`), or `null` when the page names none. */
  readonly layout: string | null;
  /** Files the page writes, relative to the output folder, sorted by code point. */
  readonly outputs: readonly string[];
  /** SHA-256 of the page's source body and of its rendered body. */
  readonly hashes: Readonly<Record<string, string>>;
}

/**
 * Writes `.mizzen/manifest.json` into the output folder: the build's index, one entry per doc page, so doctor and the
 * MCP server read the build instead of guessing which URL and file came from which source.
 *
 * Each entry names the page's URL, source file, title, layout, the output files it writes, and two SHA-256 hashes: the
 * Markdown or HTML body as the model read it (`source`), and the body after Markdown became HTML (`html`). Front
 * matter is not part of either hash: the title, URL, and layout are separate fields, so a front-matter edit still
 * changes the manifest. Hashing the files themselves is `output.build-hash`'s job (#1252), which runs once every
 * output has written.
 *
 * Pages are sorted by URL and output paths by code point, so the same model gives the same bytes (ADR 0022, rule 5).
 * App pages are left out: they are folders of files copied as assets, not pages the engine renders, and they write no
 * output of their own. A page lists the files its enabled outputs write: the HTML file and the Markdown twin, each
 * unless `outputs` turns that output off.
 *
 */
export const manifest: Output = {
  name: "manifest",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const base = site.config.base;
    const writesHtml = site.config.outputs.html !== false;
    const pages: ManifestPage[] = [];

    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      const outputs: string[] = [];
      if (writesHtml) outputs.push(indexPath(underBase(page.url, base)));
      if (site.config.outputs.twins !== false) {
        const twin = twinUrl(page.url);
        if (twin !== undefined) outputs.push(underBase(twin, base).replace(/^\//, ""));
      }
      pages.push({
        url: page.url,
        source: page.source.file,
        title: page.title,
        layout: page.frontMatter.layout ?? null,
        outputs: outputs.sort(byCodePoint),
        hashes: { source: hashOf(page.markdown), html: hashOf(page.html) },
      });
    }

    pages.sort((a, b) => byCodePoint(a.url, b.url));
    const json = `${JSON.stringify({ version: 1, pages }, null, 2)}\n`;
    return [{ path: FILE, contents: json }];
  },
};
