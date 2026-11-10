import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Diagnostic, Output, OutputContext, OutputFile, Page, Site, SourcePos } from "../contracts/index.ts";

/*
 * Footnote rendering is GFM's: `remark-gfm` (the `gfm` Markdown plugin at order 0) parses `[^1]` references and
 * `[^1]: ...` definitions, and the render host turns them into numbered references and a back-linked footnotes
 * section. This output adds no HTML and no files. It only reports the case GFM leaves as plain text: a reference
 * whose label has no definition. It re-parses `Page.markdown` with the same two extensions so the reported line is
 * the line in the page's source file, not the line in the rendered output.
 */

/** The parser GFM uses for references: CommonMark plus the GitHub extensions. */
const processor = unified().use(remarkParse).use(remarkGfm);

/** Matches a footnote reference candidate. A GFM label has no whitespace; `[^a b]` is a link reference instead. */
const REFERENCE = /\[\^([^\s\]]+)\]/g;

/** A page whose body is Markdown; HTML pages are not parsed for footnote references. */
const MARKDOWN = /\.(?:md|markdown)$/i;

/** One reference with no matching definition, and where it starts in its source file. */
export interface UnresolvedFootnote {
  /** The label between `[^` and `]`, as written. */
  readonly label: string;
  /** The span of the whole reference, `[`, label, and `]`, in the source file. */
  readonly pos: SourcePos;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The offset where each line starts, so an mdast offset maps to a line and a column. */
function lineStarts(markdown: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < markdown.length; index++) {
    if (markdown.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** The 0-based line index of `offset`, by binary search over {@link lineStarts}. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The number of code points in `text`, so a column counts a character once, as the contracts do. */
function codePoints(text: string): number {
  return [...text].length;
}

/** `true` when the `[` at `index` is escaped by an odd number of backslashes. */
function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let before = index - 1; before >= 0 && markdown[before] === "\\"; before--) backslashes++;
  return backslashes % 2 === 1;
}

/** What the tree tells the scan: spans that are code, and starts that are not references to report. */
interface TreeScan {
  /** Fenced code and inline code, where `[^label]` is text and never a reference. */
  readonly code: readonly { readonly start: number; readonly end: number }[];
  /** Offsets of resolved references and of definition markers, which are not unresolved references. */
  readonly markers: ReadonlySet<number>;
}

/**
 * Walks the tree once. A reference with a definition is a `footnoteReference` node, so its start is a marker; a
 * reference without one stays text and is found by the scan. A definition's own marker is skipped the same way.
 */
function scanTree(tree: Root): TreeScan {
  const code: { start: number; end: number }[] = [];
  const markers = new Set<number>();

  const visit = (node: Nodes): void => {
    const position = node.position;
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (node.type === "code" || node.type === "inlineCode") {
      if (start !== undefined && end !== undefined) code.push({ start, end });
    } else if (node.type === "footnoteReference" || node.type === "footnoteDefinition") {
      if (start !== undefined) markers.add(start);
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };

  visit(tree);
  return { code, markers };
}

/** `true` when `offset` lies inside one of the code spans. */
function inCode(code: readonly { readonly start: number; readonly end: number }[], offset: number): boolean {
  return code.some((span) => offset >= span.start && offset < span.end);
}

/**
 * Every `[^label]` in `markdown` whose label has no `[^label]:` definition, in document order. `file` is the source
 * file the positions name and `bodyLine` is the 1-based line where `markdown` starts in that file (the line after the
 * front matter). Escaped references (`\[^label]`) and references inside fenced or inline code are not references and
 * are left out. Parsing with `remark-parse` plus `remark-gfm` keeps positions exact.
 */
export function unresolvedFootnotes(markdown: string, file: string, bodyLine = 1): readonly UnresolvedFootnote[] {
  if (markdown === "") return [];
  const tree = processor.parse(markdown) as Root;
  const { code, markers } = scanTree(tree);
  const starts = lineStarts(markdown);
  const found: UnresolvedFootnote[] = [];

  for (const match of markdown.matchAll(REFERENCE)) {
    const offset = match.index;
    const label = match[1]!;
    if (isEscaped(markdown, offset) || inCode(code, offset) || markers.has(offset)) continue;

    const index = lineIndexAt(starts, offset);
    const column = codePoints(markdown.slice(starts[index]!, offset)) + 1;
    found.push({
      label,
      pos: {
        file,
        line: index + bodyLine,
        column,
        endLine: index + bodyLine,
        endColumn: column + codePoints(match[0]) - 1,
      },
    });
  }

  return found;
}

/**
 * Reports every footnote reference without a definition as a warning at its source line. The output writes no files:
 * rendering is GFM's (the `gfm` plugin) and this unit only supplies the diagnostic GFM cannot, because an unresolved
 * reference has no node to attach one to.
 */
export const footnoteCheck: Output = {
  name: "footnote-check",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const pages: readonly Page[] = [...site.pages].sort((a, b) => byCodePoint(a.url, b.url));
    for (const page of pages) {
      if (page.kind !== "doc" || !MARKDOWN.test(page.source.file)) continue;
      for (const finding of unresolvedFootnotes(page.markdown, page.source.file, page.source.line)) {
        const diagnostic: Diagnostic = {
          id: "footnote.missing-definition",
          severity: "warning",
          message: `Footnote reference "[^${finding.label}]" has no definition.`,
          pos: finding.pos,
          help: `Add \`[^${finding.label}]: text\` to define it, or escape the reference as \`\\[^${finding.label}]\`.`,
        };
        ctx.report(diagnostic);
      }
    }
    return [];
  },
};
