import type { Heading, Page, RepositoryConfig, Site, SourcePos } from "../contracts/index.ts";

/*
 * Per-heading "suggest an edit" links: one issue URL for every heading that has a position in the
 * source. The URL opens the host's new-issue form with the page, the source line, and the heading
 * already filled in. Like `app-pages.ts`, this file exports no `Output`: it is a helper the outputs
 * and the theme may call, not a unit the pipeline runs.
 */

/** GitHub's issue title limit; the title is cut to this many code points, ellipsis included. */
const MAX_TITLE = 256;

/** Longest issue URL written. Browsers and hosts accept more, but some proxies cut the request line at 8 KiB. */
const MAX_URL = 8000;

/** Marks a value that had to be cut to fit {@link MAX_URL}. */
const ELLIPSIS = "…";

/** The two hosts whose new-issue URLs this unit knows. */
type IssueHost = "github" | "gitlab";

/** One heading's suggested change, as {@link suggestLinksOf} returns it. */
export interface SuggestLink {
  /** The page's URL path, as the model writes it. */
  readonly page: string;
  /** The heading's `id`, the anchor a reader can follow. */
  readonly heading: string;
  /** The heading's plain text. */
  readonly text: string;
  /** 1-based line of the heading in its source file. */
  readonly line: number;
  /** The new-issue URL, encoded and within {@link MAX_URL}. */
  readonly url: string;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The repository's web URL without trailing slashes or a `.git` suffix, or `undefined` when it has no web URL. */
function webRoot(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (trimmed === "") return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.hostname === "") return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

/**
 * Which new-issue form the host uses. GitLab's path and query keys differ; every other web host is
 * treated as GitHub, whose `/issues/new?title=&body=` form is the common one.
 *
 * This detector is local on purpose: the "edit this page" unit (N35) has its own copy until the two
 * land together and a shared repository helper can replace both. It reads the hostname only, so a
 * repository named `gitlab-docs` on another host does not choose GitLab by mistake.
 */
function issueHost(root: string): IssueHost | undefined {
  let hostname: string;
  try {
    hostname = new URL(root).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname === "") return undefined;
  return /(^|\.)gitlab\./.test(hostname) ? "gitlab" : "github";
}

/** Collapses whitespace, so a title with newlines still reads as one line in the issue form. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The issue title, cut to {@link MAX_TITLE} code points with an ellipsis so the page and heading still show. */
function titleOf(page: Page, heading: Heading): string {
  const pageTitle = oneLine(page.title) || page.url;
  const headingText = oneLine(heading.text) || heading.id;
  const full = `Suggest edit: ${pageTitle} — ${headingText}`;
  const points = [...full];
  if (points.length <= MAX_TITLE) return full;
  return `${points.slice(0, MAX_TITLE - 1).join("")}${ELLIPSIS}`;
}

/** The heading's position, or `undefined` when the heading is generated and has no real source span. */
function posOf(heading: Heading): SourcePos | undefined {
  const pos = (heading as { readonly pos?: Partial<SourcePos> }).pos;
  if (pos === undefined || typeof pos.file !== "string" || pos.file === "") return undefined;
  const line = pos.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  const column = typeof pos.column === "number" && pos.column >= 1 ? pos.column : 1;
  const endLine = typeof pos.endLine === "number" && pos.endLine >= line ? pos.endLine : line;
  const endColumn = typeof pos.endColumn === "number" && pos.endColumn >= 1 ? pos.endColumn : column;
  return { file: pos.file, line, column, endLine, endColumn };
}

/** The issue body: the page, its source file and line, and the heading anchor, each on its own line. */
function bodyOf(page: Page, heading: Heading, pos: SourcePos): string {
  return [
    "Suggest an edit to this heading.",
    "",
    `Page: ${page.url}`,
    `Source: ${pos.file}:${pos.line}`,
    `Heading: ${heading.id}`,
    "",
  ].join("\n");
}

/** The host's new-issue URL for an already-built title and body. */
function issueUrl(root: string, host: IssueHost, title: string, body: string): string {
  const encodedTitle = encodeURIComponent(title.toWellFormed());
  const encodedBody = encodeURIComponent(body.toWellFormed());
  return host === "gitlab"
    ? `${root}/-/issues/new?issue[title]=${encodedTitle}&issue[description]=${encodedBody}`
    : `${root}/issues/new?title=${encodedTitle}&body=${encodedBody}`;
}

/**
 * The URL, cut to {@link MAX_URL} by shortening the body. The body is cut by code point, never inside
 * one, and ends with an ellipsis; the title is already capped by {@link titleOf}. Returns `undefined`
 * only when even an empty body cannot fit, which a sane repository URL never causes.
 */
function fitUrl(root: string, host: IssueHost, title: string, body: string): string | undefined {
  const full = issueUrl(root, host, title, body);
  if (full.length <= MAX_URL) return full;

  const points = [...body];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = issueUrl(root, host, title, `${points.slice(0, middle).join("")}${ELLIPSIS}`);
    if (candidate.length <= MAX_URL) low = middle;
    else high = middle - 1;
  }
  const candidate = issueUrl(root, host, title, `${points.slice(0, low).join("")}${ELLIPSIS}`);
  return candidate.length <= MAX_URL ? candidate : undefined;
}

/**
 * The new-issue URL for one heading, or `undefined` when there is nothing to point at: no repository,
 * a repository URL that is not a web URL, no page URL, an unknown heading (`heading.id` is not one of
 * `page.headings`), or a generated heading with no source position.
 *
 * The heading is looked up in the page so the position always comes from the model, not from a copy
 * the caller may have built.
 */
export function suggestIssueLink(
  repository: RepositoryConfig | undefined,
  page: Page,
  heading: Heading | undefined,
): string | undefined {
  if (repository === undefined || heading === undefined) return undefined;
  const root = webRoot(repository.url);
  if (root === undefined) return undefined;
  const host = issueHost(root);
  if (host === undefined) return undefined;
  if (page.url === "") return undefined;

  const found = page.headings.find((candidate) => candidate.id === heading.id);
  if (found === undefined || found.id === "") return undefined;
  const pos = posOf(found);
  if (pos === undefined) return undefined;

  return fitUrl(root, host, titleOf(page, found), bodyOf(page, found, pos));
}

/** Headings in document order, with the id as the tie-break so the result never depends on input order. */
function byPosition(a: Heading, b: Heading): number {
  return (a.pos?.line ?? 0) - (b.pos?.line ?? 0) || (a.pos?.column ?? 0) - (b.pos?.column ?? 0) || byCodePoint(a.id, b.id);
}

/**
 * Every heading of every page that can carry a suggestion, in a deterministic order: pages by URL,
 * headings by source position. A site with no repository has no links.
 */
export function suggestLinksOf(site: Site): readonly SuggestLink[] {
  const repository = site.config.repository;
  if (repository === undefined) return [];

  const links: SuggestLink[] = [];
  for (const page of [...site.pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    for (const heading of [...page.headings].sort(byPosition)) {
      const url = suggestIssueLink(repository, page, heading);
      if (url === undefined) continue;
      links.push({ page: page.url, heading: heading.id, text: heading.text, line: heading.pos.line, url });
    }
  }
  return links;
}
