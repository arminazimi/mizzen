/**
 * Planning precise edits of Markdown link destinations and code-block contents.
 *
 * A caller names a page by URL and one element by its exact source span, and supplies the page's
 * Markdown source. The planner parses that source, finds the element whose span matches the target
 * exactly, and returns a {@link Patch} that replaces only the link's destination or the fence's
 * contents. Labels, titles, fence markers, info strings, indentation, and line endings are all
 * carried through untouched.
 *
 * Like `planHeadingEdit`, nothing here writes a file: the patch is plain data, compatible with the
 * strict `writeFilePatches` transaction. A target that is not one whole source element, that is
 * ambiguous, or that comes from generated content is a typed {@link TargetPlanError}, never a
 * guess.
 */
import type { Code, Definition, Link, LinkReference, Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseFrontMatter } from "../content/frontmatter.ts";
import type { Page, Site } from "../contracts/index.ts";
import {
  hashSource,
  PatchError,
  spanToOffsets,
  type Patch,
  type PatchSpan,
} from "./patch.ts";

/** Why a link or fence edit could not be planned. Each code names one situation. */
export type TargetPlanErrorCode =
  | "edit.unknown-page"
  | "edit.generated-target"
  | "edit.ambiguous-target"
  | "edit.source-mismatch"
  | "edit.out-of-range"
  | "edit.unsupported-target";

/** A refused link or fence plan. `target` echoes the span the caller asked to edit. */
export class TargetPlanError extends Error {
  readonly code: TargetPlanErrorCode;
  readonly url: string;
  readonly target: PatchSpan;
  /** The element or destination span the plan pointed at, when it got that far. */
  readonly span: PatchSpan | undefined;

  constructor(
    code: TargetPlanErrorCode,
    message: string,
    detail: { readonly url: string; readonly target: PatchSpan; readonly span?: PatchSpan },
  ) {
    super(message);
    this.name = "TargetPlanError";
    this.code = code;
    this.url = detail.url;
    this.target = detail.target;
    this.span = detail.span;
  }
}

/** What {@link planLinkEdit} needs. */
export interface PlanLinkEditOptions {
  /** The site model the page comes from. */
  readonly site: Site;
  /** The page's source file as text, including front matter and line endings. */
  readonly source: string;
  /** The page's output URL, as it appears in the site model. */
  readonly url: string;
  /** The whole source element to edit: a link, a reference link, or a reference definition. */
  readonly target: PatchSpan;
  /** The link's new destination, written exactly as it should appear in the Markdown. */
  readonly newDestination: string;
}

/** What {@link planCodeFenceEdit} needs. */
export interface PlanCodeFenceEditOptions {
  /** The site model the page comes from. */
  readonly site: Site;
  /** The page's source file as text, including front matter and line endings. */
  readonly source: string;
  /** The page's output URL, as it appears in the site model. */
  readonly url: string;
  /** The whole fenced or indented code block to edit. */
  readonly target: PatchSpan;
  /** The block's new contents, without its fence lines or final line ending. */
  readonly newBody: string;
}

type NotedNode = Nodes & {
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
};

const processor = unified().use(remarkParse).use(remarkGfm).freeze();

/** The raw Markdown tree of `source`, with front matter removed. Node offsets stay body-relative. */
function parseSource(source: string): { readonly tree: Root; readonly bodyStart: number } {
  const frontMatter = parseFrontMatter(source, "");
  // `parseFrontMatter` strips a BOM and all front matter; `body` is therefore a suffix of `source`.
  const bodyStart = source.length - frontMatter.body.length;
  return { tree: processor.parse(frontMatter.body) as Root, bodyStart };
}

/** The start of every line in `source`; `source.split("\n")` gives the matching line texts. */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** The index of the line that holds `offset`; `offset === source.length` names the last line. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A line without its ending. A trailing `\r` belongs to the ending, not the content. */
function contentOfLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The offset just after a line's last content character, before its line ending. */
function contentEndOf(source: string, starts: readonly number[], line: number): number {
  const end = line + 1 < starts.length ? (starts[line + 1] ?? 0) - 1 : source.length;
  if (end > (starts[line] ?? 0) && source.charCodeAt(end - 1) === 13) return end - 1;
  return end;
}

/** The UTF-16 width of the code point that starts at `offset`. */
function codePointWidth(source: string, offset: number): number {
  const first = source.charCodeAt(offset);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = source.charCodeAt(offset + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return 2;
  }
  return 1;
}

/** The UTF-16 start of the code point that ends just before `offset`. */
function previousCodePointStart(source: string, offset: number): number {
  const first = source.charCodeAt(offset - 2);
  const second = source.charCodeAt(offset - 1);
  const surrogatePair =
    first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff;
  return surrogatePair ? offset - 2 : offset - 1;
}

/**
 * The inclusive span of the offsets `[start, end)`.
 *
 * Throws a {@link TargetPlanError} when the range does not name text in `source`.
 */
function spanOfRange(
  source: string,
  starts: readonly number[],
  start: number,
  end: number,
  file: string,
  url: string,
  target: PatchSpan,
): PatchSpan {
  if (start < 0 || end <= start || end > source.length) {
    throw new TargetPlanError(
      "edit.out-of-range",
      `The planned span ${start}-${end} is outside ${JSON.stringify(url)}'s source text.`,
      { url, target },
    );
  }
  const startLine = lineAt(starts, start) + 1;
  const last = end - 1;
  const endLine = lineAt(starts, last) + 1;
  const startColumn = Array.from(source.slice(starts[startLine - 1] ?? 0, start)).length + 1;
  const endColumn = Array.from(source.slice(starts[endLine - 1] ?? 0, end)).length;
  return { file, line: startLine, column: startColumn, endLine, endColumn };
}

/**
 * A patch over `[start, end)`. A zero-length range is widened by one neighbouring code point,
 * which the replacement writes back, because the patch contract names at least one character.
 */
function patchOver(
  source: string,
  starts: readonly number[],
  start: number,
  end: number,
  replacement: string,
  file: string,
  url: string,
  target: PatchSpan,
): Patch {
  let from = start;
  let to = end;
  let text = replacement;
  if (from === to) {
    if (to < source.length) {
      const width = codePointWidth(source, to);
      text = replacement + source.slice(to, to + width);
      to += width;
    } else if (from > 0) {
      const previous = previousCodePointStart(source, from);
      text = source.slice(previous, from) + replacement;
      from = previous;
    } else {
      throw new TargetPlanError(
        "edit.unsupported-target",
        `An empty source cannot hold an insertion at ${url}.`,
        { url, target },
      );
    }
  }
  return {
    span: spanOfRange(source, starts, from, to, file, url, target),
    expected: source.slice(from, to),
    replacement: text,
    beforeHash: hashSource(source),
  };
}

/** The page a URL names, or a refusal. */
function pageAt(site: Site, url: string, target: PatchSpan): Page {
  const page = site.pages.find((candidate) => candidate.url === url);
  if (page === undefined) {
    throw new TargetPlanError("edit.unknown-page", `No page has the URL ${JSON.stringify(url)}.`, {
      url,
      target,
    });
  }
  if (page.kind !== "doc") {
    throw new TargetPlanError(
      "edit.generated-target",
      `${JSON.stringify(url)} is ${page.kind === "app" ? "an app page" : "an asset"}; its Markdown elements are generated and have no source to patch.`,
      { url, target },
    );
  }
  if (target.file !== undefined && target.file !== page.source.file) {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The target names ${JSON.stringify(target.file)}, but ${JSON.stringify(url)} comes from ${JSON.stringify(page.source.file)}.`,
      { url, target },
    );
  }
  return page;
}

/** The target's offsets in `source`, or a refusal when it names no text there. */
function offsetsOf(source: string, target: PatchSpan, url: string): { start: number; end: number } {
  try {
    return spanToOffsets(source, target);
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    throw new TargetPlanError(
      "edit.out-of-range",
      `The target ${JSON.stringify(url)} names is outside the source text given: ${error.message}`,
      { url, target },
    );
  }
}

interface Candidate {
  readonly node: NotedNode;
  readonly start: number;
  readonly end: number;
}

/** Every node whose source offsets are known, body offsets shifted into `source`. */
function candidatesOf(tree: Root, bodyStart: number): Candidate[] {
  const found: Candidate[] = [];
  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      found.push({ node: node as NotedNode, start: bodyStart + start, end: bodyStart + end });
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

/** The error for a target that names no source link or fence. */
function missingTarget(
  candidates: readonly Candidate[],
  targetSpan: { readonly start: number; readonly end: number },
  url: string,
  target: PatchSpan,
  kind: "link" | "code",
): TargetPlanError {
  const partial = candidates.find(
    (candidate) =>
      candidate.start === targetSpan.start &&
      (candidate.node.type === "link" ||
        candidate.node.type === "linkReference" ||
        candidate.node.type === "definition" ||
        candidate.node.type === "code"),
  );
  if (partial !== undefined) {
    return new TargetPlanError(
      "edit.source-mismatch",
      `The target on ${JSON.stringify(url)} does not name the whole source element; it starts at a ${partial.node.type} but ends elsewhere.`,
      { url, target },
    );
  }
  return new TargetPlanError(
    "edit.source-mismatch",
    `No Markdown ${kind === "link" ? "link" : "code fence"} starts at ${target.line}:${target.column} of ${JSON.stringify(url)}; pass the page's own Markdown source.`,
    { url, target },
  );
}

/** Whitespace Markdown allows between a link's parts. */
function isSpace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

/** Skips spaces, tabs, and line endings. */
function skipSpace(source: string, index: number, limit: number): number {
  let at = index;
  while (at < limit && isSpace(source[at])) at += 1;
  return at;
}

/** The destination part of an inline link, or a refusal. */
function inlineDestination(
  source: string,
  node: Link,
  start: number,
  end: number,
  bodyStart: number,
  url: string,
  target: PatchSpan,
): { readonly start: number; readonly end: number } {
  const last = node.children[node.children.length - 1];
  const lastEnd = last?.position?.end.offset;
  const close = lastEnd === undefined ? start + 1 : bodyStart + lastEnd;
  if (source[close] !== "]" || source[close + 1] !== "(") {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The link at ${target.line}:${target.column} of ${JSON.stringify(url)} is not written as an inline link; its destination cannot be located.`,
      { url, target },
    );
  }

  let at = skipSpace(source, close + 2, end);
  let destinationStart: number;
  let destinationEnd: number;
  if (source[at] === "<") {
    destinationStart = at + 1;
    at = destinationStart;
    while (at < end) {
      if (source[at] === "\\") {
        at += 2;
        continue;
      }
      if (source[at] === ">") break;
      at += 1;
    }
    if (source[at] !== ">") {
      throw new TargetPlanError(
        "edit.source-mismatch",
        `The link at ${target.line}:${target.column} of ${JSON.stringify(url)} has an unterminated destination.`,
        { url, target },
      );
    }
    destinationEnd = at;
    at = skipSpace(source, at + 1, end);
  } else {
    destinationStart = at;
    let depth = 0;
    while (at < end) {
      const character = source[at];
      if (character === "\\") {
        at += 2;
        continue;
      }
      if (character === "(") {
        depth += 1;
        at += 1;
        continue;
      }
      if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
        at += 1;
        continue;
      }
      if (depth === 0 && isSpace(character)) break;
      at += 1;
    }
    destinationEnd = at;
    at = skipSpace(source, at, end);
  }

  if (source[at] !== ")") {
    const quote = source[at];
    if (quote !== '"' && quote !== "'" && quote !== "(") {
      throw new TargetPlanError(
        "edit.source-mismatch",
        `The link at ${target.line}:${target.column} of ${JSON.stringify(url)} has text after its destination that is not a title.`,
        { url, target },
      );
    }
    const closing = quote === "(" ? ")" : quote;
    at += 1;
    while (at < end) {
      if (source[at] === "\\") {
        at += 2;
        continue;
      }
      if (source[at] === closing) break;
      at += 1;
    }
    if (source[at] !== closing) {
      throw new TargetPlanError(
        "edit.source-mismatch",
        `The link at ${target.line}:${target.column} of ${JSON.stringify(url)} has an unterminated title.`,
        { url, target },
      );
    }
    at = skipSpace(source, at + 1, end);
  }
  if (source[at] !== ")") {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The link at ${target.line}:${target.column} of ${JSON.stringify(url)} does not close after its destination.`,
      { url, target },
    );
  }
  return { start: destinationStart, end: destinationEnd };
}

/** The destination part of a reference definition, or a refusal. */
function definitionDestination(
  source: string,
  start: number,
  end: number,
  url: string,
  target: PatchSpan,
): { readonly start: number; readonly end: number } {
  let at = start + 1;
  while (at < end) {
    if (source[at] === "\\") {
      at += 2;
      continue;
    }
    if (source[at] === "]") break;
    at += 1;
  }
  if (source[at] !== "]" || source[at + 1] !== ":") {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The definition at ${target.line}:${target.column} of ${JSON.stringify(url)} is not written as a link definition.`,
      { url, target },
    );
  }

  at = skipSpace(source, at + 2, end);
  let destinationStart: number;
  let destinationEnd: number;
  if (source[at] === "<") {
    destinationStart = at + 1;
    at = destinationStart;
    while (at < end) {
      if (source[at] === "\\") {
        at += 2;
        continue;
      }
      if (source[at] === ">") break;
      at += 1;
    }
    if (source[at] !== ">") {
      throw new TargetPlanError(
        "edit.source-mismatch",
        `The definition at ${target.line}:${target.column} of ${JSON.stringify(url)} has an unterminated destination.`,
        { url, target },
      );
    }
    destinationEnd = at;
  } else {
    destinationStart = at;
    let depth = 0;
    while (at < end) {
      const character = source[at];
      if (character === "\\") {
        at += 2;
        continue;
      }
      if (character === "(") {
        depth += 1;
        at += 1;
        continue;
      }
      if (character === ")") {
        if (depth === 0) {
          at += 1;
          continue;
        }
        depth -= 1;
        at += 1;
        continue;
      }
      if (isSpace(character)) break;
      at += 1;
    }
    destinationEnd = at;
  }
  return { start: destinationStart, end: destinationEnd };
}

/** Every definition that a reference link resolves through, in document order. */
function definitionsOf(candidates: readonly Candidate[], reference: LinkReference): Definition[] {
  return candidates
    .filter(
      (candidate): candidate is Candidate & { node: Definition } =>
        candidate.node.type === "definition" &&
        (candidate.node as Definition).identifier === reference.identifier,
    )
    .map((candidate) => candidate.node);
}

/**
 * Plans the single patch that changes a Markdown link's destination.
 *
 * The page is found by `url`, then the element by `target`, a span that must name one whole link
 * (`[label](destination)`), one whole reference link (`[label][reference]`), or one whole
 * definition (`[reference]: destination`). A reference link's destination is found through its
 * definition; exactly one definition must match its identifier. The returned patch replaces only
 * the destination text, so angles, labels, titles, and line endings stay as written.
 *
 * The patch carries the SHA-256 of `source`, so a stale file is refused before the span is touched.
 *
 * Throws a {@link TargetPlanError}:
 * - `edit.unknown-page` when no page has the URL;
 * - `edit.generated-target` when the page is an app or asset, or the target is raw HTML;
 * - `edit.out-of-range` when the target is outside `source`;
 * - `edit.ambiguous-target` when a reference resolves through more than one definition;
 * - `edit.unsupported-target` when a reference has no definition;
 * - `edit.source-mismatch` when the target does not name one whole link in the given source.
 */
export function planLinkEdit(options: PlanLinkEditOptions): Patch {
  const { site, source, url, target, newDestination } = options;
  const page = pageAt(site, url, target);
  const { start, end } = offsetsOf(source, target, url);
  const { tree, bodyStart } = parseSource(source);
  const candidates = candidatesOf(tree, bodyStart);
  const starts = lineStartsOf(source);

  const matches = candidates.filter(
    (candidate) => candidate.start === start && candidate.end === end,
  );
  if (matches.length > 1) {
    throw new TargetPlanError(
      "edit.ambiguous-target",
      `The target on ${JSON.stringify(url)} names ${matches.length} Markdown nodes; the edit is ambiguous.`,
      { url, target },
    );
  }
  const match = matches[0];
  if (match === undefined) throw missingTarget(candidates, { start, end }, url, target, "link");
  if (match.node.type === "html") {
    throw new TargetPlanError(
      "edit.generated-target",
      `The target on ${JSON.stringify(url)} is raw HTML, not a Markdown link; it has no Markdown source to patch.`,
      { url, target },
    );
  }

  let destination: { readonly start: number; readonly end: number };
  let withinTarget = true;
  if (match.node.type === "link") {
    destination = inlineDestination(source, match.node as Link, start, end, bodyStart, url, target);
  } else if (match.node.type === "linkReference") {
    const definitions = definitionsOf(candidates, match.node as LinkReference);
    if (definitions.length === 0) {
      throw new TargetPlanError(
        "edit.unsupported-target",
        `The reference link at ${target.line}:${target.column} of ${JSON.stringify(url)} has no definition, so its destination cannot be resolved.`,
        { url, target },
      );
    }
    if (definitions.length > 1) {
      throw new TargetPlanError(
        "edit.ambiguous-target",
        `The reference link at ${target.line}:${target.column} of ${JSON.stringify(url)} resolves through ${definitions.length} definitions; the edit is ambiguous.`,
        { url, target },
      );
    }
    const definition = definitions[0]!;
    const definitionCandidate = candidates.find((candidate) => candidate.node === definition);
    if (definitionCandidate === undefined) {
      throw new TargetPlanError(
        "edit.source-mismatch",
        `The definition for the link at ${target.line}:${target.column} of ${JSON.stringify(url)} has no usable source span.`,
        { url, target },
      );
    }
    destination = definitionDestination(
      source,
      definitionCandidate.start,
      definitionCandidate.end,
      url,
      target,
    );
    withinTarget = false;
  } else if (match.node.type === "definition") {
    destination = definitionDestination(source, start, end, url, target);
  } else {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The target on ${JSON.stringify(url)} is a ${match.node.type}, not a Markdown link.`,
      { url, target },
    );
  }

  if (withinTarget && (destination.start < start || destination.end > end)) {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The destination for the target on ${JSON.stringify(url)} lies outside the requested span.`,
      { url, target },
    );
  }
  return patchOver(
    source,
    starts,
    destination.start,
    destination.end,
    newDestination,
    page.source.file,
    url,
    target,
  );
}

/** How a code block is written, so its body can be replaced without its markers. */
interface CodeLayout {
  readonly openLine: number;
  readonly closeLine: number | undefined;
  /** The first line that is body rather than a fence marker. */
  readonly firstBodyLine: number;
  readonly indent: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly empty: boolean;
}

/** The layout of a fenced code block, or `undefined` when the code node is not fenced. */
function fenceLayout(
  source: string,
  starts: readonly number[],
  start: number,
  end: number,
): CodeLayout | undefined {
  const openLine = lineAt(starts, start);
  const lineStart = starts[openLine] ?? 0;
  const openEnd = contentEndOf(source, starts, openLine);
  const open = source.slice(start, openEnd);
  const fence = /^(`{3,}|~{3,})/.exec(open);
  if (fence === null) return undefined;
  const marker = fence[1]!;
  const character = marker[0]!;
  const indent = Math.max(0, start - lineStart);
  const lines = source.split("\n");

  let closeLine: number | undefined;
  for (let line = openLine + 1; line < lines.length; line += 1) {
    const content = contentOfLine(lines[line] ?? "");
    const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(content);
    if (closing !== null && closing[2]![0] === character && closing[2]!.length >= marker.length) {
      closeLine = line;
      break;
    }
  }

  const firstBodyLine = openLine + 1;
  const lastBodyLine =
    closeLine === undefined ? lineAt(starts, Math.max(start, end - 1)) : closeLine - 1;
  const empty = lastBodyLine < firstBodyLine;
  const bodyStart = empty
    ? closeLine === undefined
      ? openEnd
      : (starts[closeLine] ?? end)
    : (starts[firstBodyLine] ?? end);
  return {
    openLine,
    closeLine,
    firstBodyLine,
    indent,
    bodyStart,
    bodyEnd: empty ? bodyStart : contentEndOf(source, starts, lastBodyLine),
    empty,
  };
}

/** An indented code block's layout, or `undefined` when the node is a fence or not indented. */
function indentedLayout(
  source: string,
  starts: readonly number[],
  start: number,
  end: number,
): CodeLayout | undefined {
  if (start !== (starts[lineAt(starts, start)] ?? 0)) return undefined;
  const last = lineAt(starts, Math.max(start, end - 1));
  const lines = source.split("\n");
  for (let line = lineAt(starts, start); line <= last; line += 1) {
    const content = contentOfLine(lines[line] ?? "");
    if (content !== "" && !content.startsWith("    ")) return undefined;
  }
  const openLine = lineAt(starts, start);
  return {
    openLine,
    closeLine: undefined,
    firstBodyLine: openLine,
    indent: 4,
    bodyStart: start,
    bodyEnd: contentEndOf(source, starts, last),
    empty: last === openLine && contentEndOf(source, starts, last) === start,
  };
}

/** The source body's text, stripped of the block's indentation, for a source check. */
function bodyTextOf(source: string, layout: CodeLayout, lastLine: number, eol: string): string {
  const lines = source.split("\n");
  const text: string[] = [];
  for (let line = layout.firstBodyLine; line <= lastLine; line += 1) {
    const content = contentOfLine(lines[line] ?? "");
    let at = 0;
    while (at < layout.indent && content[at] === " ") at += 1;
    text.push(content.slice(at));
  }
  return text.join(eol);
}

/** The replacement for a block body: every line indented like the opening line and joined with its line ending. */
function indentedBody(lines: readonly string[], indent: number, eol: string): string {
  const prefix = " ".repeat(indent);
  return lines.map((line) => `${prefix}${line}`).join(eol);
}

/** Splits new body text into fence-body lines, accepting any line ending in the input. */
function bodyLinesOf(body: string): string[] {
  return body === "" ? [] : body.split(/\r\n|\r|\n/);
}

/**
 * Plans the single patch that changes a fenced code block's contents.
 *
 * The page is found by `url`, then the block by `target`, a span that must name one whole code
 * block. The returned patch replaces only the text between the fence lines (or the indented
 * block's lines), and re-indents every new line the way the block was indented. Fence markers,
 * info strings, and surrounding line endings stay exactly as written.
 *
 * The patch carries the SHA-256 of `source`, so a stale file is refused before the span is touched.
 *
 * Throws a {@link TargetPlanError}:
 * - `edit.unknown-page` when no page has the URL;
 * - `edit.generated-target` when the page is an app or asset, or the target is raw HTML;
 * - `edit.out-of-range` when the target is outside `source`;
 * - `edit.source-mismatch` when the target does not name one whole code block, or its content
 *   does not match the parsed block.
 */
export function planCodeFenceEdit(options: PlanCodeFenceEditOptions): Patch {
  const { site, source, url, target, newBody } = options;
  const page = pageAt(site, url, target);
  const { start, end } = offsetsOf(source, target, url);
  const { tree, bodyStart } = parseSource(source);
  const candidates = candidatesOf(tree, bodyStart);
  const starts = lineStartsOf(source);

  const matches = candidates.filter(
    (candidate) => candidate.start === start && candidate.end === end,
  );
  if (matches.length > 1) {
    throw new TargetPlanError(
      "edit.ambiguous-target",
      `The target on ${JSON.stringify(url)} names ${matches.length} Markdown nodes; the edit is ambiguous.`,
      { url, target },
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw missingTarget(candidates, { start, end }, url, target, "code");
  }
  if (match.node.type === "html") {
    throw new TargetPlanError(
      "edit.generated-target",
      `The target on ${JSON.stringify(url)} is raw HTML, not a fenced code block; it has no Markdown source to patch.`,
      { url, target },
    );
  }
  if (match.node.type !== "code") {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The target on ${JSON.stringify(url)} is a ${match.node.type}, not a fenced code block.`,
      { url, target },
    );
  }

  const code = match.node as Code;
  const layout = fenceLayout(source, starts, start, end) ??
    indentedLayout(source, starts, start, end);
  if (layout === undefined) {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The code block at ${target.line}:${target.column} of ${JSON.stringify(url)} has no fence or indentation this planner can read.`,
      { url, target },
    );
  }

  const lastBodyLine =
    layout.closeLine === undefined
      ? lineAt(starts, Math.max(start, end - 1))
      : layout.closeLine - 1;
  const openLineEnd = contentEndOf(source, starts, layout.openLine);
  const eol =
    source.slice(openLineEnd, openLineEnd + 2) === "\r\n"
      ? "\r\n"
      : source.slice(openLineEnd, openLineEnd + 1) === "\n"
        ? "\n"
        : "\n";
  const existing = layout.empty ? "" : bodyTextOf(source, layout, lastBodyLine, eol);
  if (existing !== code.value) {
    throw new TargetPlanError(
      "edit.source-mismatch",
      `The source at ${target.line}:${target.column} of ${JSON.stringify(url)} does not hold the code block its span names.`,
      { url, target },
    );
  }

  const body = bodyLinesOf(newBody);

  if (layout.empty) {
    if (layout.closeLine === undefined) {
      const text = body.length === 0 ? "" : `${eol}${indentedBody(body, layout.indent, eol)}`;
      return patchOver(
        source,
        starts,
        openLineEnd,
        openLineEnd,
        text,
        page.source.file,
        url,
        target,
      );
    }
    const insertion = starts[layout.closeLine] ?? end;
    const text = body.length === 0 ? "" : `${indentedBody(body, layout.indent, eol)}${eol}`;
    return patchOver(
      source,
      starts,
      insertion,
      insertion,
      text,
      page.source.file,
      url,
      target,
    );
  }

  if (body.length === 0) {
    const from = openLineEnd;
    const to = layout.closeLine === undefined
      ? (starts[lastBodyLine + 1] ?? source.length)
      : (starts[layout.closeLine] ?? end);
    return patchOver(source, starts, from, to, eol, page.source.file, url, target);
  }

  return patchOver(
    source,
    starts,
    layout.bodyStart,
    layout.bodyEnd,
    indentedBody(body, layout.indent, eol),
    page.source.file,
    url,
    target,
  );
}
