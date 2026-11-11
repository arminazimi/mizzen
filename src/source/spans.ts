import type { SourcePos } from "../contracts/source.ts";

/**
 * Source spans: every block element carries the exact place it came from, and a block's
 * ID is the start of its span, so one page's blocks can be found from their IDs.
 *
 * A span is written as `path:line:column-endLine:endColumn`. The end is inclusive and names the
 * block's last character. The two shorter forms stay valid as points: `path:line` and
 * `path:line:column` name one position and no end.
 */

/** The start and end `remark` reports for a node. Its `end` is exclusive: the column after the last character. */
export interface NodePosition {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

const FULL_SPAN = /^(.*):(\d+):(\d+)-(\d+):(\d+)$/;
const POINT_WITH_COLUMN = /^(.*):(\d+):(\d+)$/;
const POINT = /^(.*):(\d+)$/;
const DATA_SRC = /\bdata-src="([^"]*)"/g;

/** Decodes the entities that can appear in an attribute value from the Markdown stage. */
function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every part of a span is at least 1: lines and columns are 1-based. */
function positive(...values: readonly number[]): boolean {
  return values.every((value) => Number.isInteger(value) && value >= 1);
}

/** A parsed span, or `undefined` when a part is missing or its end runs before its start. */
function spanOfParts(
  file: string | undefined,
  line: number,
  column: number,
  endLine: number,
  endColumn: number,
): SourcePos | undefined {
  if (!file || !positive(line, column, endLine, endColumn)) return undefined;
  if (endLine < line || (endLine === line && endColumn < column)) return undefined;
  return { file, line, column, endLine, endColumn };
}

/**
 * Converts a node's `remark` position to a source span. `remark`'s end is exclusive, so the last
 * character is one column before `end.column`; the result is clamped so a position never runs
 * before its start.
 */
export function spanFromPosition(file: string, position: NodePosition): SourcePos {
  const { line, column } = position.start;
  const endLine = position.end.line;
  const endColumn = endLine === line ? Math.max(column, position.end.column - 1) : Math.max(1, position.end.column - 1);
  return { file, line, column, endLine, endColumn };
}

/** A block's ID: the start of its span, `path:line:column`. */
export function blockIdOf(span: SourcePos): string {
  return `${span.file}:${span.line}:${span.column}`;
}

/** Writes a span the way `data-src` and the source map carry it: `path:line:column-endLine:endColumn`. */
export function formatSpan(span: SourcePos): string {
  return `${span.file}:${span.line}:${span.column}-${span.endLine}:${span.endColumn}`;
}

/**
 * Parses a `data-src` or source-map value. The full form is `path:line:column-endLine:endColumn`;
 * `path:line` and `path:line:column` are points, where the end equals the start.
 * A path containing a colon still parses: the numbers are taken from the right.
 */
export function parseSpan(value: string): SourcePos | undefined {
  const full = FULL_SPAN.exec(value);
  if (full) {
    return spanOfParts(full[1], Number(full[2]), Number(full[3]), Number(full[4]), Number(full[5]));
  }

  const withColumn = POINT_WITH_COLUMN.exec(value);
  if (withColumn) {
    const line = Number(withColumn[2]);
    const column = Number(withColumn[3]);
    return spanOfParts(withColumn[1], line, column, line, column);
  }

  const point = POINT.exec(value);
  if (point) {
    const line = Number(point[2]);
    return spanOfParts(point[1], line, 1, line, 1);
  }

  return undefined;
}

/**
 * Why `span` does not name text in `source`, or `undefined` when it does. `source` is a file's text or
 * one body of it, and `firstLine` is the 1-based line of the file where `source` starts.
 *
 * A span is invalid when a part is not a whole number of at least 1, when its end runs before its
 * start, or when it names a line or a column the text does not have. Columns are counted in JavaScript
 * string units, the way `remark` reports them, so a non-BMP character is two columns as it is two units;
 * that is what keeps a span and `sliceSpan` telling the same story on every line ending. A caller
 * reports the reason and leaves the location out: a stale span is never clamped into a new one.
 */
export function spanProblem(source: string, span: SourcePos, firstLine = 1): string | undefined {
  if (!positive(span.line, span.column, span.endLine, span.endColumn)) {
    return "the line and column must be whole numbers of at least 1";
  }
  if (span.endLine < span.line || (span.endLine === span.line && span.endColumn < span.column)) {
    return "the end runs before the start";
  }

  const lines = source.split("\n");
  const lastLine = firstLine + lines.length - 1;
  if (span.line < firstLine || span.line > lastLine) {
    return `line ${span.line} is outside lines ${firstLine} to ${lastLine}`;
  }
  if (span.endLine > lastLine) {
    return `end line ${span.endLine} is outside lines ${firstLine} to ${lastLine}`;
  }

  const first = lines[span.line - firstLine] ?? "";
  if (span.column > first.length + 1) {
    return `column ${span.column} is past the end of line ${span.line}`;
  }
  const last = lines[span.endLine - firstLine] ?? "";
  if (span.endColumn > last.length) {
    return `end column ${span.endColumn} is past the end of line ${span.endLine}`;
  }
  return undefined;
}

/** Every `data-src` span in a page's HTML, in document order. */
export function spansIn(html: string): SourcePos[] {
  const spans: SourcePos[] = [];
  for (const match of html.matchAll(DATA_SRC)) {
    const span = parseSpan(decodeAttr(match[1] ?? ""));
    if (span) spans.push(span);
  }
  return spans;
}

/**
 * The span of the block whose ID is `blockId`, from the page's HTML, where every block carries its
 * span on `data-src`.
 *
 * A block's ID carries only its start, so the page is what supplies the end. Without it, a full
 * span string still parses, but a bare ID is a point: its end equals its start.
 */
export function spanOf(blockId: string, page?: string | readonly SourcePos[]): SourcePos | undefined {
  if (page === undefined) return parseSpan(blockId);
  const spans = typeof page === "string" ? spansIn(page) : page;
  return spans.find((span) => blockIdOf(span) === blockId);
}

/**
 * The source text a span names. Lines are split on `\n` and a `\r` stays at the end of its line, so
 * a CRLF file keeps its line endings. The end column is inclusive, so slicing a block's span
 * returns exactly that block's Markdown.
 */
export function sliceSpan(source: string, span: SourcePos): string {
  const lines = source.split("\n");
  const startLine = span.line;
  if (span.endLine < startLine) return "";
  const first = lines[startLine - 1];
  if (first === undefined) return "";
  if (span.endLine === startLine) return first.slice(span.column - 1, span.endColumn);

  const last = lines[span.endLine - 1];
  if (last === undefined) return "";
  const middle = lines.slice(startLine, span.endLine - 1);
  return [first.slice(span.column - 1), ...middle, last.slice(0, span.endColumn)].join("\n");
}
