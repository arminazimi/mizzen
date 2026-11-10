import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";

/** Characters per token the estimator assumes, until a tokenizer is chosen. */
const CHARS_PER_TOKEN = 4;

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
 * The file a page's JSON lands at: the page's URL with `index.json` in place of the HTML file, so a pretty URL
 * (`/guide/install/`) gives `/guide/install/index.json`, the site root gives `/index.json`, and a URL that already
 * names an HTML file (`/404.html`) gives its `.json` name (`/404.json`). Mirrors the Markdown twin, which swaps
 * `.html` for `.md`. Returns undefined for a URL that names a file of another kind, which has no page JSON.
 */
function jsonPath(url: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".json")}`;
  if (last.includes(".")) return undefined;
  return `${url.endsWith("/") ? url : `${url}/`}index.json`;
}

/** The value of a `last_modified_at` that is a string or a `Date` from the front matter parser, as `YYYY-MM-DD`; anything else reads as no date. */
function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

/** The page's description, trimmed; empty or non-string values read as no description. */
function descriptionOf(page: Page): string | null {
  const value = page.frontMatter.description;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One heading, as an agent reads it: its level, its anchor, and its plain text. */
interface PageHeading {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** The JSON body of one page, with a fixed key order so the same model gives the same bytes. */
interface PageJson {
  /** Output URL, including `base`. */
  readonly url: string;
  readonly title: string;
  /** Front matter description, or `null` when the page has none. */
  readonly description: string | null;
  /** Every heading in document order. */
  readonly headings: readonly PageHeading[];
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
  /** Front matter `last_modified_at` as `YYYY-MM-DD`, or `null` when absent or unreadable. */
  readonly lastModified: string | null;
  /** Estimated tokens in the page's Markdown body, rounded up, at {@link CHARS_PER_TOKEN} characters per token. */
  readonly tokens: number;
}

/**
 * Writes one `<url>/index.json` per doc page for MCP and agents: the page's URL, title, description, headings,
 * source file, last change, and token count, so a tool reads the text and structure without parsing HTML.
 *
 * The token count is an estimate, not a tokenizer: the Markdown body's length in characters divided by
 * {@link CHARS_PER_TOKEN} (characters / 4) and rounded up, which is close enough to plan a context window and
 * documented in the output itself by that rule.
 *
 * App pages are skipped, since they are programs rather than documents, and so is a doc page whose URL names a file
 * that is not HTML, because it has no `index.json` address. The site `base` is stripped from the path, as the HTML
 * output strips it, so a project site writes `guide/install/index.json` into the output folder. Files come back
 * sorted by path (ADR 0022, rule 5), whatever order the model had.
 */
export const pageJson: Output = {
  name: "page-json",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      const url = jsonPath(page.url);
      if (url === undefined) continue;
      const body: PageJson = {
        url: page.url,
        title: page.title,
        description: descriptionOf(page),
        headings: page.headings.map(({ depth, id, text }) => ({ depth, id, text })),
        source: page.source.file,
        lastModified: isoDate(page.frontMatter.last_modified_at),
        tokens: Math.ceil(page.markdown.length / CHARS_PER_TOKEN),
      };
      files.push({
        path: underBase(url, site.config.base).replace(/^\//, ""),
        contents: `${JSON.stringify(body, null, 2)}\n`,
      });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
