import type { Nodes, Root } from "mdast";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import type { SourcePos } from "../contracts/source.ts";
import { codeRefsIn, type CodeRef } from "../drift/code-refs.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { examplesIn } from "../markdown/plugins/example-fence.ts";
import { spanFromPosition, spanProblem } from "../source/spans.ts";
import { isAppPage } from "./app-pages.ts";

/** Where the map lands, relative to the output folder. */
const FILE = "sourcemap.json";

/** One heading of a page, as the source map records it. */
interface Section {
  /** The `id` the heading has in the built HTML. */
  readonly id: string;
  /** Heading level, 1 to 6. */
  readonly level: number;
  /** 1-based line in the source file, front matter included. */
  readonly line: number;
  /** 1-based column where the heading starts. */
  readonly column: number;
  /** 1-based line where the heading ends (the same as `line` for a one-line heading). */
  readonly endLine: number;
  /** Column of the heading's last character (inclusive). */
  readonly endColumn: number;
  /** The heading's plain text, as the built page shows it. */
  readonly text: string;
}

/** One link of a page: the target as written in the source, and the span it occupies. */
interface LinkEntry {
  /** The link target as written in the source. */
  readonly href: string;
  /** 1-based line in the source file, front matter included. */
  readonly line: number;
  /** 1-based column where the link starts. */
  readonly column: number;
  /** 1-based line where the link ends (the same as `line` for a one-line link). */
  readonly endLine: number;
  /** Column of the link's last character (inclusive). */
  readonly endColumn: number;
}

/** The file and line range a drift claim cites, exactly as the page writes it. */
interface TargetEntry {
  /** The cited file, relative to the repository root, with forward slashes. */
  readonly file: string;
  /** The first cited line. */
  readonly line: number;
  /** The last cited line of a range; absent when the page names one line. */
  readonly endLine?: number;
  /** The cited column; absent when the page names only lines. */
  readonly column?: number;
}

/** One piece of evidence a trust or drift signal rests on, with its span in the page's source. */
interface ClaimEntry {
  /** `trust` for a runnable example, `drift` for a code reference. */
  readonly kind: "trust" | "drift";
  /** 1-based line where the claim starts. */
  readonly line: number;
  /** 1-based column where the claim starts. */
  readonly column: number;
  /** 1-based line where the claim ends. */
  readonly endLine: number;
  /** Column of the claim's last character (inclusive). */
  readonly endColumn: number;
  /** Trust only: the example's id, as `examples.json` and the theme know it. */
  readonly example?: string;
  /** Drift only: the citation as `drift.json` writes it, such as `src/app.ts:12`. */
  readonly reference?: string;
  /** Drift only: the file and range the page points at. */
  readonly target?: TargetEntry;
}

/** One page of the map. `sections`, `links`, and `claims` are always present, in document order. */
interface PageEntry {
  /** The page's URL path from the site root, as the model writes it. */
  readonly url: string;
  /** The source file, relative to the repository root, with forward slashes. */
  readonly source: string;
  /** Headings in document order. */
  readonly sections: readonly Section[];
  /** Links in document order. */
  readonly links: readonly LinkEntry[];
  /** Trust and drift claims in document order: examples first, then code references at each position. */
  readonly claims: readonly ClaimEntry[];
}

/** Where an output reports a finding, which is the engine's `ctx.report`. */
type Report = (diagnostic: Diagnostic) => void;

/** Compares by code point, never by locale. */
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

/**
 * Every Markdown link in the page body, in document order, with its span in the source file. A link node
 * without a position is reported and left out: a line the parser never recorded is worse than no entry.
 */
export function linksOf(tree: Root, source: SourcePos, report: Report = () => {}): LinkEntry[] {
  const links: LinkEntry[] = [];
  visit(tree, (node) => {
    if (node.type !== "link" || node.url === "") return;
    if (node.position === undefined) {
      report({
        id: "sourcemap.missing-position",
        severity: "warning",
        message: `The link to "${node.url}" has no source position, so it is left out of the source map.`,
        pos: source,
        help: "Rebuild the page from its current source.",
      });
      return;
    }
    const span = spanFromPosition(source.file, node.position);
    links.push({
      href: node.url,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
    });
  });
  return links;
}

/** The citation as `drift.json` writes it: `path:line`, `path:line-endLine`, or `path:line:column`. */
// shortcut: a copy of drift-report's referenceOf, kept here because that unit does not export it.
function referenceOf(ref: CodeRef): string {
  const lines = ref.endLine === undefined || ref.endLine === ref.line ? `${ref.line}` : `${ref.line}-${ref.endLine}`;
  return `${ref.path}:${lines}${ref.column === undefined ? "" : `:${ref.column}`}`;
}

/** The range a claim starts and ends at, from any span-shaped value. */
function numbersOf(span: {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}): Pick<ClaimEntry, "line" | "column" | "endLine" | "endColumn"> {
  return { line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn };
}

/** Claims by position, then kind, then example id or citation, so two runs agree on the order. */
function compareClaims(a: ClaimEntry, b: ClaimEntry): number {
  return (
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn ||
    byCodePoint(a.kind, b.kind) ||
    byCodePoint(a.example ?? a.reference ?? "", b.example ?? b.reference ?? "")
  );
}

/**
 * The page's trust and drift evidence claims in `tree`, its body parsed at `page.source.line`, in document
 * order. Trust claims are its runnable examples, and drift claims are its `path:line` code references. One
 * whose span no longer fits the page body gets a `sourcemap.stale-range` diagnostic and is left out, so the
 * map never carries a location that names no text. The cited target range is not checked here: whether the
 * code still holds is the drift check's finding, and reading the target file would make the map depend on
 * more than the model.
 */
export function claimsOf(page: Page, tree: Root, report: Report = () => {}): readonly ClaimEntry[] {
  const candidates: ClaimEntry[] = [];
  for (const example of examplesIn(tree)) {
    candidates.push({ kind: "trust", example: example.id, ...numbersOf(example.pos) });
  }
  for (const ref of codeRefsIn(tree, page.source.file)) {
    candidates.push({
      kind: "drift",
      reference: referenceOf(ref),
      target: {
        file: ref.path,
        line: ref.line,
        ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
        ...(ref.column === undefined ? {} : { column: ref.column }),
      },
      ...numbersOf(ref.pos),
    });
  }

  const claims: ClaimEntry[] = [];
  for (const claim of candidates) {
    const span = { file: page.source.file, ...numbersOf(claim) };
    const problem = spanProblem(page.markdown, span, page.source.line);
    if (problem === undefined) {
      claims.push(claim);
      continue;
    }
    report({
      id: "sourcemap.stale-range",
      severity: "warning",
      message: `The ${claim.kind} claim at line ${claim.line}, column ${claim.column} is stale: ${problem}, so the source map leaves it out.`,
      help: "Rebuild the page from its current source, or update the claim to match it.",
    });
  }
  return claims.sort(compareClaims);
}

/** The page's Markdown, the form that carries link positions. Other content is HTML and has no Markdown links. */
function isMarkdown(page: Page): boolean {
  return /\.(?:md|markdown)$/i.test(page.source.file);
}

/** A page's source file, relative to the repository root, with forward slashes on every platform. */
function sourcePath(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/**
 * Writes `sourcemap.json`: one entry per document page, naming its source file and,
 * for every heading, Markdown link, and trust or drift claim, the exact range in the source that produced it.
 *
 * The positions are the ones the model kept. A page's headings already carry their source line, so sections read
 * `page.headings` directly. Links are inline nodes the model does not keep, so the output parses the page's Markdown
 * again with the same parser the model used; `page.source.line` is the line its body starts on, so positions come
 * back relative to the whole file, front matter included.
 *
 * App pages are left out: they are programs, not documents, and the spec's source map is about content. Pages are
 * sorted by URL and each list stays in document order, so the same model gives the same bytes.
 *
 * ## Claims
 *
 * `claims` is where a page's trust and drift signals touch the source, so a consumer can go from a
 * `trust.json` reason or a `drift.json` finding to the exact text it rests on:
 *
 * - `trust` claims are the page's runnable examples (`test` fences); `example` is the id the example
 *   report and the theme use, and the span covers the whole fence.
 * - `drift` claims are the page's `path:line` code references; the span covers the reference in the page,
 *   `reference` is the citation as `drift.json` writes it, and `target` is the file and line range the
 *   page names, exactly as written.
 *
 * A claim whose span no longer fits `page.markdown` is stale: the output reports one
 * `sourcemap.stale-range` diagnostic and leaves the claim out, because a location that names no text is
 * worse than none. A link node without a position gets `sourcemap.missing-position` for the same reason.
 * The target range is carried, never checked or adjusted: whether the cited code still holds is the drift
 * check's finding, and reading the target file would make the map depend on more than the model. A review's
 * evidence is the page's git history rather than text, so it has no claim; the page entry is its location.
 */
export const sourcemap: Output = {
  name: "sourcemap",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const options = { pages: site.pages };
    const pages: PageEntry[] = [];

    for (const page of site.pages) {
      if (page.kind !== "doc" || isAppPage(page.url, options)) continue;

      const sections: Section[] = page.headings.map((heading) => ({
        id: heading.id,
        level: heading.depth,
        line: heading.pos.line,
        column: heading.pos.column,
        endLine: heading.pos.endLine,
        endColumn: heading.pos.endColumn,
        text: heading.text,
      }));

      const tree = isMarkdown(page) ? await parseMarkdown(page.markdown, page.source.line) : undefined;
      const links = tree === undefined ? [] : linksOf(tree, { ...page.source, file: sourcePath(page) }, ctx.report);
      const claims = tree === undefined ? [] : claimsOf(page, tree, ctx.report);

      pages.push({ url: page.url, source: sourcePath(page), sections, links, claims });
    }

    const json = `${JSON.stringify({ version: 0, pages }, null, 2)}\n`;
    return [{ path: FILE, contents: json }];
  },
};
