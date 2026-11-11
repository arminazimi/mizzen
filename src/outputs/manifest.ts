import { createHash } from "node:crypto";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { twinUrl } from "./twins.ts";

/** Where the manifest lands, relative to the output folder. */
const FILE = ".mizzen/manifest.json";

/** Compares by code point, never by locale. */
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

/**
 * The source path as an identity names it: forward slashes on every platform, and no `./` prefix, so a Windows
 * checkout describes the same source as a Linux one.
 */
function sourcePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
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

/** Which page owns an output path, for the collision message. */
interface Claim {
  readonly url: string;
  readonly source: string;
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
 * Pages are sorted by URL and output paths by code point, so the same model gives the same bytes whatever order its
 * pages arrived in. Two pages that write one file are ambiguous ownership: the page with the lower URL keeps the path,
 * the other page does not list it, and an error names both sources. App pages are left out: they are folders of files
 * copied as assets, not pages the engine renders, and they write no output of their own. A page lists the files its
 * enabled outputs write: the HTML file and the Markdown twin, each unless `outputs` turns that output off.
 *
 */
export const manifest: Output = {
  name: "manifest",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const base = site.config.base;
    const writesHtml = site.config.outputs.html !== false;
    const writesTwins = site.config.outputs.twins !== false;
    const pages: ManifestPage[] = [];
    const claimed = new Map<string, Claim>();

    const docs = site.pages.filter((page) => page.kind === "doc").sort((a, b) => byCodePoint(a.url, b.url));
    for (const page of docs) {
      const source = sourcePath(page.source.file);
      const candidates: string[] = [];
      if (writesHtml) candidates.push(indexPath(underBase(page.url, base)));
      if (writesTwins) {
        const twin = twinUrl(page.url);
        if (twin !== undefined) candidates.push(underBase(twin, base).replace(/^\//, ""));
      }

      const outputs: string[] = [];
      for (const path of candidates) {
        const first = claimed.get(path);
        if (first !== undefined) {
          if (first.url === page.url && first.source === source) continue;
          ctx.report({
            id: "manifest.output-collision",
            severity: "error",
            message: `Two pages write "${path}": ${first.source} (${first.url}) and ${source} (${page.url}).`,
            pos: page.source,
            help: "Change one page's `permalink`, or turn off the output that writes the file.",
          });
          continue;
        }
        claimed.set(path, { url: page.url, source });
        outputs.push(path);
      }

      pages.push({
        url: page.url,
        source,
        title: page.title,
        layout: page.frontMatter.layout ?? null,
        outputs: outputs.sort(byCodePoint),
        hashes: { source: hashOf(page.markdown), html: hashOf(page.html) },
      });
    }

    const json = `${JSON.stringify({ version: 1, pages }, null, 2)}\n`;
    return [{ path: FILE, contents: json }];
  },
};
