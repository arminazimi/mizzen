import type { Nodes, Root } from "mdast";
import { posix } from "node:path";
import type { Heading, Page, Site } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { permalink } from "../content/permalink.ts";
import { parseMarkdown } from "../markdown/parse.ts";

/*
 * `related.json`: for every doc page, the few other pages it is most related to, read from the links its body makes
 * and the headings it shares. The score is documented here because it is the whole feature:
 *
 *   score = 2 × shared internal links + 1 × shared headings
 *
 * A shared link is an internal target (fragment and query dropped) both pages link to. A shared heading is a heading
 * whose plain text both pages have, compared after case folding and collapsing whitespace, falling back to its id
 * when the text is empty. A page with a score of zero is not related. Ties break by URL in code-point order, and the
 * five highest scores are kept.
 *
 * Links are read from the Markdown body with the same parser the rest of the engine uses, so reference-style links
 * resolve too. A page whose source is HTML has no Markdown nodes, so its body's `<a href>` values are read instead.
 * Relative link targets resolve against the page's URL, except a link to a source file (`.md` or `.markdown`), which
 * resolves against the page's source folder and goes through the same pretty-URL rules the build uses. External
 * links (a scheme or `//`) are ignored, since a page cannot relate to another page through a site that is not this
 * one.
 */

/** Weight of one shared internal link. */
const LINK_WEIGHT = 2;

/** Weight of one shared heading. */
const HEADING_WEIGHT = 1;

/** Most related pages kept per page. */
const MAX_RELATED = 5;

/** The file the map lands at, relative to the output folder. */
const FILE = "related.json";

/** A fake origin, so relative URLs resolve without the environment deciding anything. */
const ORIGIN = "https://mizzen.invalid";

/** A scheme (`https:`, `mailto:`) or protocol-relative (`//`) URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** A link to a page's source file, which the build rewrites to the page's URL. */
const SOURCE_LINK = /\.(?:md|markdown)$/i;

/** An `<a>` tag's `href`, in any of HTML's three attribute forms. */
const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/** One related page, as {@link relatedPages} returns it. */
export interface RelatedEntry {
  /** The related page's URL. */
  readonly url: string;
  /** `2 × sharedLinks + sharedHeadings`. */
  readonly score: number;
  /** Internal link targets both pages have. */
  readonly sharedLinks: number;
  /** Heading texts both pages have. */
  readonly sharedHeadings: number;
}

/** One page and its related pages, highest score first. */
export interface RelatedPage {
  /** The page's URL. */
  readonly url: string;
  /** Up to {@link MAX_RELATED} other pages, highest score first, then by URL. */
  readonly related: readonly RelatedEntry[];
}

/** The cached facts of one page: its internal link targets and heading keys, each a set. */
interface Profile {
  readonly links: ReadonlySet<string>;
  readonly headings: ReadonlySet<string>;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Walks the mdast tree in document (pre-order) order. */
function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** Every link target in the Markdown body, in document order: inline links and the definitions references read. */
function markdownLinks(tree: Root): string[] {
  const definitions = new Map<string, string>();
  const direct: string[] = [];
  const references: string[] = [];
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    else if (node.type === "link") direct.push(node.url);
    else if (node.type === "linkReference") references.push(node.identifier);
  });
  for (const identifier of references) {
    const target = definitions.get(identifier);
    if (target !== undefined) direct.push(target);
  }
  return direct;
}

/** The small set of entities an `href` value carries in rendered HTML. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Every `<a href>` of an HTML body; escaped code samples are not `<a>` tags, so they are left out. */
function htmlLinks(html: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(ANCHOR)) links.push(unescapeHtml(match[1] ?? match[2] ?? match[3] ?? ""));
  return links;
}

/** The page's source file with forward slashes, as link resolution needs it. */
function sourcePath(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/** The href without its `#fragment` and `?query`, since neither names a page. */
function withoutQuery(href: string): string {
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}

/** Prefix `base` to a site-absolute path that does not carry it yet, matching the model's URLs. */
function withBase(base: string, path: string): string {
  if (base === "" || path === base || path.startsWith(`${base}/`)) return path;
  if (path === "/") return `${base}/`;
  return `${base}${path}`;
}

/** The file's path as a URL pathname, encoding characters so every target has one spelling. */
function urlPath(path: string, base?: URL): string | undefined {
  try {
    return new URL(path, base ?? ORIGIN).pathname;
  } catch {
    return undefined;
  }
}

/**
 * One page URL's canonical spelling for comparison: no `index.html`, no `.html` extension, one slash between
 * segments, and a trailing slash on a pretty path. A path whose last segment names another file (`feed.xml`) keeps
 * its extension. Fragments and queries never reach this function.
 */
function cleanPath(pathname: string): string {
  const path = pathname.replace(/\/{2,}/g, "/");
  if (path === "") return "/";
  if (/\/index\.html?$/i.test(path)) return path.replace(/\/index\.html?$/i, "/");
  const withoutHtml = /\/[^/]*\.html?$/i.test(path) ? path.replace(/\.html?$/i, "/") : path;
  if (withoutHtml.endsWith("/")) return withoutHtml;
  const last = withoutHtml.slice(withoutHtml.lastIndexOf("/") + 1);
  return last.includes(".") ? withoutHtml : `${withoutHtml}/`;
}

/**
 * A link target's canonical internal URL, or `undefined` when the link leaves the site, only names an anchor, or
 * names no path. A source-file link resolves against the page's source folder and uses the build's pretty-URL rules;
 * every other relative link resolves against the page's URL. `base` is the site's base, which absolute paths outside
 * it gain so a link written from the domain root still names the page the model has.
 */
function targetOf(href: string, page: Page, base: string): string | undefined {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || EXTERNAL.test(raw)) return undefined;
  const path = withoutQuery(raw).trim();
  if (path === "") return undefined;

  if (SOURCE_LINK.test(path)) {
    const source = path.startsWith("/")
      ? path.slice(1)
      : posix.normalize(posix.join(posix.dirname(sourcePath(page)), path));
    if (source === "" || source === ".." || source.startsWith("../")) return undefined;
    return cleanPath(urlPath(permalink(source, { base })) ?? "");
  }

  const resolved = path.startsWith("/")
    ? urlPath(withBase(base, path))
    : urlPath(path, new URL(page.url, ORIGIN));
  return resolved === undefined ? undefined : cleanPath(resolved);
}

/** A heading's key: its folded text, or its id when the text is empty. */
function headingKey(heading: Heading): string | undefined {
  const text = heading.text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  if (text !== "") return `text:${text}`;
  return heading.id === "" ? undefined : `id:${heading.id}`;
}

/** The page's cached link and heading sets. */
async function profileOf(page: Page, base: string): Promise<Profile> {
  const raw = /\.(?:md|markdown)$/i.test(page.source.file)
    ? markdownLinks(await parseMarkdown(page.markdown, page.source.line))
    : htmlLinks(page.html);
  const links = new Set<string>();
  for (const href of raw) {
    const target = targetOf(href, page, base);
    if (target !== undefined) links.add(target);
  }
  const headings = new Set<string>();
  for (const heading of page.headings) {
    const key = headingKey(heading);
    if (key !== undefined) headings.add(key);
  }
  return { links, headings };
}

/** How many values two sets share, walking the smaller one. */
function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const value of small) if (large.has(value)) count += 1;
  return count;
}

/**
 * The related pages of every doc page: up to {@link MAX_RELATED}, highest score first, ties by URL. The score is
 * `2 × shared internal links + 1 × shared headings`; a page with no shared link or heading with another is related to
 * nothing. App and asset pages are left out, since they are programs and files rather than documents.
 *
 * Every page's link and heading sets are built once and reused for every pair, so the work is one parse per page and
 * one set intersection per pair rather than a parse per comparison. Pages come back sorted by URL, so the same model
 * gives the same result whatever order it held.
 */
export async function relatedPages(site: Site): Promise<readonly RelatedPage[]> {
  const base = site.config.base;
  const pages = site.pages.filter((page) => page.kind === "doc").sort((a, b) => byCodePoint(a.url, b.url));
  const profiles: Profile[] = [];
  for (const page of pages) profiles.push(await profileOf(page, base));

  const found = pages.map(() => [] as RelatedEntry[]);
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const left = profiles[i]!;
      const right = profiles[j]!;
      const sharedLinks = shared(left.links, right.links);
      const sharedHeadings = shared(left.headings, right.headings);
      const score = sharedLinks * LINK_WEIGHT + sharedHeadings * HEADING_WEIGHT;
      if (score === 0) continue;
      found[i]!.push({ url: pages[j]!.url, score, sharedLinks, sharedHeadings });
      found[j]!.push({ url: pages[i]!.url, score, sharedLinks, sharedHeadings });
    }
  }

  return pages.map((page, index) => ({
    url: page.url,
    related: found[index]!.sort((a, b) => b.score - a.score || byCodePoint(a.url, b.url)).slice(0, MAX_RELATED),
  }));
}

/**
 * Writes `related.json`: one entry per doc page, with up to five related pages ordered by score and then URL. The
 * JSON is two-space indented with a final line feed and fixed key order, so the same model gives the same bytes
 * (ADR 0022, rule 5).
 */
export const related: Output = {
  name: "related",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const pages = await relatedPages(site);
    return [{ path: FILE, contents: `${JSON.stringify({ version: 0, pages }, null, 2)}\n` }];
  },
};
