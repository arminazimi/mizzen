import { posix } from "node:path";
import type { Nodes, Root } from "mdast";
import type { Page } from "../contracts/content.ts";
import type { SourcePos } from "../contracts/source.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { spanFromPosition } from "../source/spans.ts";

/**
 * `path:line` code references (N07): the places a page points at a line of code, so drift checks can
 * compare what the page says with what the code holds.
 *
 * A reference names a file and a line or a run of lines, and sometimes a column:
 *
 * - `src/foo.ts:48`, `src/foo.ts:48:7`
 * - `src/foo.ts:48-52`
 * - `src/foo.ts#L48`, `src/foo.ts#L48-L52`
 *
 * The file is resolved from the page's own folder: `guide/setup.md` naming `src/foo.ts` means
 * `guide/src/foo.ts`. A path starting with `/` is already from the repository root (`/src/foo.ts`),
 * and `..` moves up one folder while never going above the root. Results always use `/` and carry no
 * leading `./` or `/`. Without a page file, a path stays exactly as written.
 */

/** One code reference found in a page, with the span of the Markdown node that holds it. */
export interface CodeRef {
  /** The target file, relative to the repository root and using `/`. */
  readonly path: string;
  /** The first line the reference names, 1-based. */
  readonly line: number;
  /** The last line of a range (`path:10-12` or `path#L10-L12`); absent for one line. */
  readonly endLine?: number;
  /** The column (`path:10:4`); absent when the reference names only lines. */
  readonly column?: number;
  /**
   * The span of the Markdown node that holds the reference. The Markdown pipeline parses `:line` as a
   * text directive, so a reference split across adjacent inline nodes carries the span from the first
   * to the last node it touches.
   */
  readonly pos: SourcePos;
}

/** A whole path segment: it starts and ends with a letter, digit, `_`, or `-`, with `.` allowed inside. */
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";

/** A path: optional leading `/`, `.` or `..` segments, then at least one named segment. */
const PATH = `\\/?(?:\\.\\.?\\/|${SEGMENT}\\/)*${SEGMENT}`;

/**
 * A reference: a path followed by `:line`, `:line-line`, `:line:column`, or `#Lline`, `#Lline-Lline`.
 * The lookbehind keeps a match from starting inside a longer word or a URL, and the lookahead keeps it
 * from ending inside one (`foo.ts:12bar` is not a reference).
 */
const REF = new RegExp(
  `(?<![A-Za-z0-9_./:-])(${PATH})(?::(\\d+)(?:-(\\d+))?(?::(\\d+))?|#L(\\d+)(?:-L(\\d+))?)(?![A-Za-z0-9_])`,
  "g",
);

/** A path must look like a file, not a word: at least one of `.`, `_`, `-`, or `/`. */
const PATH_LIKE = /[._/-]/;

/** The bare `test` fence meta that N01 uses to mark a runnable example; detected here without importing that unit. */
const TEST_META = /(?:^|\s)test(?=\s|$)/;

/** Markdown pages only: an HTML page's body is not Markdown, so it has no Markdown references. */
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

/** A reference before it is given a span: the parsed parts and the match's place in the scanned text. */
interface Found {
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  readonly column?: number;
  /** Index of the match's first character in the scanned text. */
  readonly start: number;
  /** Index after the match's last character. */
  readonly end: number;
}

/**
 * Resolves a reference path from the page's folder, or from the repository root when it starts with `/`.
 * `posix.normalize` on an absolute path drops `.` and `..` and never climbs above the root; the leading
 * `/` is then removed so every result is repository-relative.
 */
function resolveRef(rawPath: string, file: string | undefined): string {
  const slash = file?.lastIndexOf("/") ?? -1;
  const folder = slash === -1 ? "" : (file ?? "").slice(0, slash);
  const target = rawPath.startsWith("/") ? rawPath : `${folder}/${rawPath}`;
  return posix.normalize(`/${target}`).replace(/^\/+/, "");
}

/** True when a fence's meta carries the bare `test` token (not `test=…`). */
function isTestFence(meta: string | null | undefined): boolean {
  return TEST_META.test(meta ?? "");
}

/** Every reference in one piece of text, in the order it appears. */
function foundIn(value: string, file: string | undefined): Found[] {
  const found: Found[] = [];
  for (const match of value.matchAll(REF)) {
    const rawPath = match[1];
    if (rawPath === undefined || !PATH_LIKE.test(rawPath)) continue;

    const colonLine = match[2];
    const hashLine = match[5];
    const line = Number(colonLine ?? hashLine);
    const endLine = match[3] !== undefined
      ? Number(match[3])
      : match[6] !== undefined
        ? Number(match[6])
        : undefined;
    const column = match[4] === undefined ? undefined : Number(match[4]);

    if (!Number.isInteger(line) || line < 1) continue;
    if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < line)) continue;
    if (column !== undefined && (!Number.isInteger(column) || column < 1)) continue;
    // The documented forms do not combine a line range with a column.
    if (endLine !== undefined && column !== undefined) continue;

    const start = match.index;
    found.push({
      path: resolveRef(rawPath, file),
      line,
      start,
      end: start + match[0].length,
      ...(endLine === undefined ? {} : { endLine }),
      ...(column === undefined ? {} : { column }),
    });
  }
  return found;
}

/** The key that makes two findings at the same node span identical. */
function keyOf(ref: CodeRef): string {
  return [
    ref.path,
    ref.line,
    ref.endLine ?? "",
    ref.column ?? "",
    ref.pos.file,
    ref.pos.line,
    ref.pos.column,
    ref.pos.endLine,
    ref.pos.endColumn,
  ].join("\u0000");
}

/** Adds `ref` unless an identical one at the same span is already there. */
function add(out: CodeRef[], seen: Set<string>, ref: CodeRef): void {
  const key = keyOf(ref);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(ref);
}

/** Adds every reference found in one node, with that node's span. */
function scanNode(node: Nodes & { readonly value: string }, file: string | undefined, out: CodeRef[], seen: Set<string>): void {
  if (!node.position) return;
  const pos = spanFromPosition(file ?? "", node.position);
  for (const found of foundIn(node.value, file)) {
    add(out, seen, {
      path: found.path,
      line: found.line,
      pos,
      ...(found.endLine === undefined ? {} : { endLine: found.endLine }),
      ...(found.column === undefined ? {} : { column: found.column }),
    });
  }
}

/** A run of adjacent inline nodes scanned as one piece of text. */
interface Piece {
  readonly value: string;
  readonly node: Nodes;
}

/** The text a node contributes to an inline run, or `undefined` when it is not text. */
function textOf(node: Nodes): string | undefined {
  if (node.type === "text") return node.value;
  // remark-directive turns `:48` into a text directive; reading it back restores the source text.
  if (node.type === "textDirective") return `:${node.name}`;
  return undefined;
}

/** The piece that holds the character at `index`, if any. */
function pieceAt(pieces: readonly Piece[], index: number): Piece | undefined {
  let offset = 0;
  for (const piece of pieces) {
    if (index < offset + piece.value.length) return piece;
    offset += piece.value.length;
  }
  return undefined;
}

/**
 * Scans adjacent text and text-directive nodes as one run, so a `path:line` the directive parser split
 * is still one reference. Its span runs from the first node it touches to the last.
 */
function scanRun(pieces: readonly Piece[], file: string | undefined, out: CodeRef[], seen: Set<string>): void {
  const value = pieces.map((piece) => piece.value).join("");
  for (const found of foundIn(value, file)) {
    const first = pieceAt(pieces, found.start);
    const last = pieceAt(pieces, found.end - 1);
    if (!first?.node.position || !last?.node.position) continue;
    const pos = spanFromPosition(file ?? "", {
      start: first.node.position.start,
      end: last.node.position.end,
    });
    add(out, seen, {
      path: found.path,
      line: found.line,
      pos,
      ...(found.endLine === undefined ? {} : { endLine: found.endLine }),
      ...(found.column === undefined ? {} : { column: found.column }),
    });
  }
}

/** Walks a parent's children: adjacent text becomes one run, every other node is visited in order. */
function walkChildren(parent: { readonly children: readonly Nodes[] }, file: string | undefined, out: CodeRef[], seen: Set<string>): void {
  let run: Piece[] = [];
  const flush = (): void => {
    if (run.length > 0) scanRun(run, file, out, seen);
    run = [];
  };
  for (const child of parent.children) {
    const value = textOf(child);
    if (value !== undefined) {
      run.push({ value, node: child });
      continue;
    }
    flush();
    walk(child, file, out, seen);
  }
  flush();
}

/** Reads one node, then its children, in document order. */
function walk(node: Nodes, file: string | undefined, out: CodeRef[], seen: Set<string>): void {
  if (node.type === "inlineCode") {
    scanNode(node, file, out, seen);
  } else if (node.type === "link") {
    scanNode({ ...node, value: node.url }, file, out, seen);
  } else if (node.type === "code" && isTestFence(node.meta)) {
    scanNode(node, file, out, seen);
  }

  if ("children" in node) walkChildren(node, file, out, seen);
}

/**
 * Every code reference in a parsed page, in document order and without duplicates at the same span.
 *
 * `file` is the page's source path relative to the repository root; it is both the folder references
 * resolve from and the `file` on every returned span. Nodes without a position are skipped, because a
 * reference is only useful when it can be located.
 */
export function codeRefsIn(tree: Root, file?: string): CodeRef[] {
  const out: CodeRef[] = [];
  walk(tree, file, out, new Set());
  return out;
}

/**
 * Every code reference in a page, parsed from `page.markdown` at `page.source.line`, with paths resolved
 * from the page's source folder. HTML pages hold no Markdown, so they return no references.
 */
export async function codeRefsOf(page: Page): Promise<CodeRef[]> {
  if (page.kind !== "doc" || !MARKDOWN_FILE.test(page.source.file)) return [];
  const tree = await parseMarkdown(page.markdown, page.source.line);
  return codeRefsIn(tree, page.source.file);
}
