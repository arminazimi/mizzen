import type { Definition, Nodes, Root } from "mdast";
import { posix } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Page, Site, SourcePos } from "../contracts/index.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { permalink } from "../content/permalink.ts";

/**
 * Checks internal links and heading anchors at model time, before anything is written.
 *
 * Every page's Markdown body is parsed again for its links, because `Page.markdown` is the only
 * contract that carries the source positions and the URLs as the author wrote them. Links are
 * compared with the page URLs and with the redirects the model already builds: config `redirects`
 * old paths and targets, and `redirect_from` front matter. An anchor with no path (`#step-2`) is
 * checked against the page it appears on; an anchor with a path is checked against the target
 * page's heading ids, following a page's `redirect_to` to the page it sends readers to.
 *
 * Resolution follows both conventions a Markdown author may use. A relative link is first resolved
 * from the page's source file, as Markdown reads it (`../install.md` from `guide/setup.md`), and
 * then from the page URL, as a browser reads it (`../install/` from `/guide/setup/`). A `.md` target
 * goes through {@link permalink}, and a root `.md` link (`/install.md`) names its source path from
 * the site root. A root link (`/guide/`) gets the site `base` when it does not carry it.
 *
 * Links that leave the site are never fetched: a scheme (`https:`, `mailto:`, `tel:`),
 * protocol-relative `//`, a query-only link (`?page=2`), an empty link, and a path outside the site
 * `base` are all skipped. A target whose last segment names a file other than `.md`, `.markdown`,
 * `.html`, or `.htm` is skipped too, because it is an asset rather than a page.
 *
 * Broken links are **warnings**, not errors: a model-time check cannot know about assets a site
 * copies, output another unit generates, or a link a later step rewrites, so it reports. The
 * built-output gate (`tools/links`, which reads the written HTML) stays the check that fails a
 * build. The output writes no file, so switching it off changes no output.
 */

/** A scheme (`https:`, `mailto:`, `tel:`) or a protocol-relative URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** A link to a page's Markdown source, which resolves through the pretty-URL rules. */
const PAGE_LINK = /\.(?:md|markdown)$/i;

/** A page file whose folder it stands for: `guide/index.md` answers for `guide/`. */
const FOLDER_PAGE = /^(?:index|README)$/i;

/** A target that names a file the build copies (an image, a PDF, a script), not a page. */
const OTHER_FILE = /\.[a-z\d]{1,10}$/i;

/** A fixed origin so URL resolution is deterministic and never reads the network. */
const ORIGIN = "https://site.invalid";

/** The two problems this check reports. */
export type LinkProblem = "link.missing-page" | "link.missing-anchor";

/** One broken internal link, with the source position of the link (or of its definition). */
export interface LinkFinding {
  /** Stable diagnostic id. */
  readonly id: LinkProblem;
  /** URL of the page that carries the link. */
  readonly page: string;
  /** The link as the author wrote it. */
  readonly href: string;
  /** The page or old path the link names, as the author wrote it. */
  readonly target: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** How to fix it. */
  readonly help: string;
  /** Where the link starts in the source. */
  readonly pos: SourcePos;
}

/** What the model knows about one page beyond its contract: its site-relative source path. */
interface Index {
  readonly base: string;
  /** Every page by comparable URL key. */
  readonly pages: ReadonlyMap<string, Page>;
  /** Every page by its site-relative source path (`guide/setup.md`), folder aliases included. */
  readonly sources: ReadonlyMap<string, Page>;
  /** The source path of every page, by URL. */
  readonly sourceOf: ReadonlyMap<string, string>;
  /** Addresses redirects answer, as comparable URL keys. */
  readonly redirects: ReadonlySet<string>;
}

/** A link resolution: what it names, or that it leaves the site and is not checked. */
type Resolution =
  | { readonly kind: "ignore" }
  | { readonly kind: "missing"; readonly target: string }
  | { readonly kind: "page"; readonly page: Page; readonly anchor: string }
  | { readonly kind: "redirect" }
  | { readonly kind: "self"; readonly anchor: string };

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A folder as the model writes it: `/`-separated, no leading `./` or trailing `/`; `""` for the root. */
function folder(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

/** A site `base` normalized to `""` or a `/docs` shape without a trailing slash. */
function normalizeBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === "" || trimmed === "/") return "";
  return (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "");
}

/** Adds `base` to a site path once, so a root link written without it still names the site. */
function withBase(path: string, base: string): string {
  if (base === "" || path === base || path.startsWith(`${base}/`)) return path;
  return path === "/" ? `${base}/` : `${base}${path}`;
}

/** Removes `base` from a path, along whole segments only; `undefined` when the path leaves the site. */
function stripBase(path: string, base: string): string | undefined {
  if (base === "") return path;
  if (path === base) return "/";
  if (path.startsWith(`${base}/`)) return path.slice(base.length) || "/";
  return undefined;
}

/** Decodes a URL escape, leaving a malformed one as written so the link still names something. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The comparable key of a page path: decoded, with `index.html` folded into its folder, no trailing
 * slash, and the root as `""`. `/guide/install/` and `/guide/install` therefore name one page.
 */
function pageKey(path: string): string {
  let value = decode(path).replace(/\\/g, "/");
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/index\.html?$/i, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value === "/" ? "" : value;
}

/** The key of a page URL, with `base` removed. */
function urlKey(url: string, base: string): string | undefined {
  const path = stripBase(url, base);
  return path === undefined ? undefined : pageKey(path);
}

/** The URL a page resolves a browser-relative link from. */
function pageOrigin(page: Page): string {
  return page.url.startsWith("/") ? page.url : `/${page.url}`;
}

/** Splits a link into its path, query, and fragment, without touching the network. */
function split(href: string): { path: string; query: string; anchor: string } {
  const hash = href.indexOf("#");
  const before = hash === -1 ? href : href.slice(0, hash);
  const anchor = hash === -1 ? "" : href.slice(hash + 1);
  const question = before.indexOf("?");
  return {
    path: question === -1 ? before : before.slice(0, question),
    query: question === -1 ? "" : before.slice(question + 1),
    anchor,
  };
}

/** The folder inside the repository that `page.source.file` is written under, `""` at the repository root. */
function sourcePrefix(site: Site): string {
  return [folder(site.config.repository?.dir), folder(site.config.source)].filter((part) => part !== "").join("/");
}

/** The page's source path relative to the site source folder, from the contract's repository-relative path. */
function siteSource(page: Page, prefix: string): string {
  const file = page.source.file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  const under = prefix !== "" && file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : file;
  return posix.normalize(under);
}

/** Every address the model already answers, plus the page and source lookups the check needs. */
function indexOf(site: Site): Index {
  const base = normalizeBase(site.config.base);
  const pages = new Map<string, Page>();
  const sources = new Map<string, Page>();
  const sourceOf = new Map<string, string>();
  const prefix = sourcePrefix(site);

  for (const page of site.pages) {
    const key = urlKey(page.url, base);
    if (key !== undefined && !pages.has(key)) pages.set(key, page);

    const source = siteSource(page, prefix);
    if (source === "" || source === "." || source.startsWith("../")) continue;
    sourceOf.set(page.url, source);
    if (!sources.has(source)) sources.set(source, page);

    const segments = source.replace(/\.[^/.]+$/, "").split("/");
    const last = segments.pop() ?? "";
    if (FOLDER_PAGE.test(last)) {
      const alias = segments.join("/");
      if (!sources.has(alias)) sources.set(alias, page);
    }
  }

  const redirects = new Set<string>();
  for (const oldPath of Object.keys(site.config.redirects)) {
    const key = redirectKey(oldPath, base);
    if (key !== undefined) redirects.add(key);
  }
  for (const target of Object.values(site.config.redirects)) {
    if (typeof target !== "string") continue;
    const key = redirectTargetKey(target, base);
    if (key !== undefined) redirects.add(key);
  }
  for (const page of site.pages) {
    const raw: unknown = page.frontMatter.redirect_from;
    if (raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== "string") continue;
      const key = redirectKey(value, base);
      if (key !== undefined) redirects.add(key);
    }
  }

  return { base, pages, sources, sourceOf, redirects };
}

/** The key of an old path from `redirects` or `redirect_from`, or `undefined` when it is not a safe path. */
function redirectKey(value: string, base: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (path.includes("\\") || path.includes("?") || path.includes("#")) return undefined;
  const withoutBase = stripBase(path, base);
  // An old path is written under the site base, like a page URL, or already with it (`/docs/old/`).
  return pageKey(withoutBase === undefined ? path : withoutBase);
}

/** The key of a config redirect's target when it is a path on the site; external targets are not addresses here. */
function redirectTargetKey(value: string, base: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || EXTERNAL.test(trimmed) || !trimmed.startsWith("/")) return undefined;
  const withoutBase = stripBase(withBase(trimmed, base), base);
  return withoutBase === undefined ? undefined : pageKey(withoutBase);
}

/** The site path a relative link names from the page's source file, or `undefined` when it leaves the site. */
function sourceTarget(path: string, page: Page, index: Index): string | undefined {
  const source = index.sourceOf.get(page.url);
  if (source === undefined) return undefined;
  const dir = posix.dirname(source);
  const joined = posix.normalize(posix.join(dir === "." ? "" : dir, path));
  if (joined === ".." || joined.startsWith("../")) return undefined;
  return joined === "." ? "" : joined.replace(/^\.\//, "");
}

/** The page a source path names, including the folder alias of an `index` page. */
function pageAtSource(source: string, index: Index): Page | undefined {
  return index.sources.get(source) ?? index.sources.get(source.replace(/\/+$/, ""));
}

/** The browser key of a relative link, resolved from the page URL and with `base` removed. */
function browserTarget(path: string, page: Page, base: string): string | undefined {
  try {
    const sitePath = new URL(path, `${ORIGIN}${pageOrigin(page)}`).pathname;
    const withoutBase = stripBase(sitePath, base);
    return withoutBase === undefined ? undefined : pageKey(withoutBase);
  } catch {
    return undefined;
  }
}

/** Every key a link's path can name, in the order the author's convention suggests. */
function candidateKeys(path: string, page: Page, index: Index): string[] {
  const keys: string[] = [];
  const add = (key: string | undefined): void => {
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  };

  if (PAGE_LINK.test(path)) {
    const source = path.startsWith("/") ? path.slice(1) : sourceTarget(path, page, index);
    if (path.startsWith("/")) {
      const bySource = pageAtSource(source ?? "", index);
      if (bySource !== undefined) add(urlKey(bySource.url, index.base));
      add(urlKey(permalink(path.replace(/^\/+/, ""), { base: index.base }), index.base));
    } else if (source !== undefined) {
      const bySource = pageAtSource(source, index);
      if (bySource !== undefined) add(urlKey(bySource.url, index.base));
      // A `.md` file that is not a page still names the URL it would have, so the check reports it.
      add(urlKey(permalink(source, { base: index.base }), index.base));
      add(browserTarget(path, page, index.base));
    }
    return keys;
  }

  if (path.startsWith("/")) {
    add(urlKey(withBase(path, index.base), index.base));
    return keys;
  }

  add(browserTarget(path, page, index.base));
  const source = sourceTarget(path, page, index);
  if (source !== undefined) {
    const bySource = pageAtSource(source, index);
    if (bySource !== undefined) add(urlKey(bySource.url, index.base));
  }
  return keys;
}

/** Whether a target path names a file the build copies rather than a page. */
function isAsset(path: string): boolean {
  if (PAGE_LINK.test(path)) return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last !== "" && OTHER_FILE.test(last) && !/\.html?$/i.test(last);
}

/** Resolves one link against the index, or says it is not a page this check can judge. */
function resolve(href: string, page: Page, index: Index): Resolution {
  if (href === "" || EXTERNAL.test(href)) return { kind: "ignore" };

  const parts = split(href);
  if (parts.path === "" && parts.query !== "") return { kind: "ignore" };
  if (parts.path === "" && parts.anchor === "") return { kind: "ignore" };
  if (parts.path === "") return { kind: "self", anchor: decode(parts.anchor) };
  if (isAsset(parts.path)) return { kind: "ignore" };

  const keys = candidateKeys(parts.path, page, index);
  if (keys.length === 0) return { kind: "ignore" };
  for (const key of keys) {
    const target = index.pages.get(key);
    if (target !== undefined) return { kind: "page", page: target, anchor: decode(parts.anchor) };
  }
  // A redirect answers the address. Its destination is not read here, so an anchor on it is
  // accepted the way the built-output gate accepts one that leaves the build.
  for (const key of keys) {
    if (index.redirects.has(key)) return { kind: "redirect" };
  }
  return { kind: "missing", target: parts.path };
}

/** Where a page's `redirect_to` sends readers: another page, or `undefined` when it leaves the site or loops. */
function redirectDestination(page: Page, index: Index): Page | undefined {
  const seen = new Set<string>([page.url]);
  let current = page;
  for (let step = 0; step < 16; step++) {
    const raw = current.frontMatter.redirect_to;
    if (typeof raw !== "string" || raw.trim() === "") return current;
    const rest = split(raw.trim());
    const keys = candidateKeys(rest.path, current, index);
    let next: Page | undefined;
    for (const key of keys) {
      next = index.pages.get(key);
      if (next !== undefined) break;
    }
    if (next === undefined || seen.has(next.url)) return undefined;
    seen.add(next.url);
    current = next;
  }
  return undefined;
}

/** Calls `visitFn` for a node and every descendant, in document order. */
function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** The source position of an mdast node, moved to the full source file the page was read from. */
function sourcePos(node: Nodes, page: Page): SourcePos {
  const start = node.position?.start ?? { line: 1, column: 1 };
  const end = node.position?.end ?? start;
  const delta = page.source.line - 1;
  return {
    file: page.source.file,
    line: start.line + delta,
    column: start.column,
    endLine: end.line + delta,
    endColumn: Math.max(start.column, end.column - 1),
  };
}

/** One link to check: its href and the node whose position is reported. */
interface Candidate {
  readonly href: string;
  readonly node: Nodes;
}

/** Parses a page's Markdown and returns its inline links and the definitions its reference links use. */
function candidatesOf(markdown: string): Candidate[] {
  const tree = unified().use(remarkParse).parse(markdown) as Root;
  const definitions = new Map<string, Definition>();
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
  });

  const checked = new Set<Definition>();
  const found: Candidate[] = [];
  visit(tree, (node) => {
    if (node.type === "link") {
      found.push({ href: node.url, node });
      return;
    }
    if (node.type !== "linkReference") return;
    const definition = definitions.get(node.identifier);
    if (definition === undefined || checked.has(definition)) return;
    checked.add(definition);
    found.push({ href: definition.url, node: definition });
  });
  return found;
}

/** The findings sorted by source file, line, and column, with duplicates from repeated references removed. */
function sorted(findings: readonly LinkFinding[]): LinkFinding[] {
  const seen = new Set<string>();
  const unique: LinkFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.pos.file}:${finding.pos.line}:${finding.pos.column}:${finding.id}:${finding.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique.sort(
    (a, b) =>
      byCodePoint(a.pos.file, b.pos.file) ||
      a.pos.line - b.pos.line ||
      a.pos.column - b.pos.column ||
      byCodePoint(a.id, b.id) ||
      byCodePoint(a.href, b.href),
  );
}

/**
 * Checks every internal link and heading anchor of the model and returns the broken ones, sorted by
 * source file, line, and column. Nothing is fetched and nothing is written; the same site always
 * gives the same list.
 */
export function checkLinks(site: Site): LinkFinding[] {
  const index = indexOf(site);
  const anchors = new Map<string, ReadonlySet<string>>();
  const ids = (page: Page): ReadonlySet<string> => {
    let found = anchors.get(page.url);
    if (found === undefined) {
      found = new Set(page.headings.map((heading) => heading.id));
      anchors.set(page.url, found);
    }
    return found;
  };

  const findings: LinkFinding[] = [];
  for (const page of site.pages) {
    if (page.kind !== "doc" || page.markdown.trim() === "") continue;
    for (const candidate of candidatesOf(page.markdown)) {
      const href = candidate.href.trim();
      const resolution = resolve(href, page, index);
      if (resolution.kind === "ignore" || resolution.kind === "redirect") continue;
      const pos = sourcePos(candidate.node, page);

      if (resolution.kind === "self") {
        if (resolution.anchor === "" || ids(page).has(resolution.anchor)) continue;
        findings.push({
          id: "link.missing-anchor",
          page: page.url,
          href,
          target: page.url,
          message: `The link to "${href}" names the anchor "#${resolution.anchor}", which no heading on ${page.url} has.`,
          help: "Fix the anchor, or give a heading the matching id.",
          pos,
        });
        continue;
      }

      if (resolution.kind === "missing") {
        findings.push({
          id: "link.missing-page",
          page: page.url,
          href,
          target: resolution.target,
          message: `The link to "${href}" names no page or redirect on this site.`,
          help: "Fix the link, or add the page or a redirect it names.",
          pos,
        });
        continue;
      }

      if (resolution.anchor === "") continue;
      const destination = redirectDestination(resolution.page, index);
      if (destination === undefined || destination.kind !== "doc") continue;
      if (ids(destination).has(resolution.anchor)) continue;
      findings.push({
        id: "link.missing-anchor",
        page: page.url,
        href,
        target: destination.url,
        message: `The link to "${href}" names the anchor "#${resolution.anchor}", which no heading on ${destination.url} has.`,
        help: "Fix the anchor, or give a heading the matching id.",
        pos,
      });
    }
  }

  return sorted(findings);
}

/**
 * The `link-check` output: runs {@link checkLinks} and reports each finding as a warning. It writes
 * no file, so it can be switched off with `outputs: { "link-check": false }` without changing the
 * build's files.
 */
export const linkCheck: Output = {
  name: "link-check",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    for (const finding of checkLinks(site)) {
      ctx.report({
        id: finding.id,
        severity: "warning",
        message: finding.message,
        pos: finding.pos,
        help: finding.help,
      });
    }
    return [];
  },
};
