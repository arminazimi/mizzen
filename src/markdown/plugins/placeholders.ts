import type { Element, ElementContent, Text } from "hast";
import type { Code, Data, InlineCode, Nodes, Root } from "mdast";
import type { Plugin } from "unified";
import type { Page } from "../../contracts/content.ts";
import { parseMarkdown } from "../parse.ts";

/**
 * `{{name}}` placeholders inside code.
 *
 * Documentation shows commands a reader runs with their own values (`{{api_key}}`,
 * `{{project}}`). This plugin finds those placeholders in code spans and code blocks and keeps
 * the variable they name:
 *
 * - Inline code renders each placeholder as
 *   `<span class="placeholder" data-var="name">{{name}}</span>` inside the usual `<code>`. The
 *   node keeps its type and position, so `data-src` stamping and heading text are unchanged.
 * - A fenced or indented block keeps its text byte for byte; its variables become a
 *   `data-placeholders` JSON attribute on the code element, because the raw Markdown twin and
 *   the highlighted source must not change. The theme wraps them when it renders the block.
 * - `\{{name}}` stays literal. Inline code drops the escape backslash (the Markdown parser
 *   already does); in a code block the text is left exactly as written.
 *
 * Everything outside code is untouched. {@link placeholdersIn} and {@link placeholdersOf} return
 * the same records for the source map and later units, in document order.
 */

/** One placeholder and where it sits in the page source. Lines and columns are 1-based; the end names the last character. */
export interface Placeholder {
  /** The variable name between the braces, trimmed. */
  readonly name: string;
  /** `inline-code` for a code span, `code` for a fenced or indented block. */
  readonly kind: "inline-code" | "code";
  /** Line the placeholder starts on. */
  readonly line: number;
  /** Column the first `{` sits in. */
  readonly column: number;
  /** Line the last `}` sits on. */
  readonly endLine: number;
  /** Column the last `}` sits in. */
  readonly endColumn: number;
}

/** A placeholder occurrence inside one node's text. `index` and `length` are in the node's value. */
interface Occurrence {
  readonly name: string;
  readonly index: number;
  readonly length: number;
  /** A backslash immediately before the braces in the source: the placeholder stays literal. */
  readonly escaped: boolean;
  /** Where the run starts in the node's slice of the source, when the source was read. */
  readonly at: number | undefined;
}

/** `{{name}}`, with letters, digits, `_`, `.`, and `-` as the name and optional spaces inside the braces. */
const PLACEHOLDER = /\{\{[ \t]*([A-Za-z0-9_.-]+)[ \t]*\}\}/g;

/** A line and column, both 1-based. */
interface Point {
  readonly line: number;
  readonly column: number;
}

/** Every placeholder-looking run in a node's value, before the source refines which are escaped. */
function occurrences(value: string): Occurrence[] {
  const found: Occurrence[] = [];
  for (const match of value.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    found.push({
      name: match[1] ?? "",
      index,
      length: match[0].length,
      escaped: index > 0 && value.charAt(index - 1) === "\\",
      at: undefined,
    });
  }
  return found;
}

/**
 * Reads the escape from the source when it is available: the Markdown parser drops the backslash
 * of `\{{name}}` inside a code span, so the value alone cannot tell an escaped placeholder from a
 * real one. An odd run of backslashes escapes; an even run leaves one literal backslash and then a
 * placeholder.
 */
function locate(node: InlineCode | Code, source: string | undefined): Occurrence[] {
  const found = occurrences(node.value);
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (source === undefined || from === undefined || to === undefined || found.length === 0) return found;
  const slice = source.slice(from, to);
  let cursor = 0;
  return found.map((occurrence) => {
    const raw = node.value.slice(occurrence.index, occurrence.index + occurrence.length);
    const at = slice.indexOf(raw, cursor);
    if (at === -1) return occurrence;
    cursor = at + raw.length;
    let backslashes = 0;
    for (let i = at - 1; i >= 0 && slice.charAt(i) === "\\"; i--) backslashes += 1;
    return { ...occurrence, escaped: backslashes % 2 === 1, at };
  });
}

/** The point `offset` characters into `text`, which starts at `at`. */
function advance(at: Point, text: string, offset: number): Point {
  let line = at.line;
  let column = at.column;
  for (let i = 0; i < offset; i++) {
    if (text.charAt(i) === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** The absolute offset of an occurrence in the source, from the node's start offset. */
function sourceOffset(node: InlineCode | Code, occurrence: Occurrence): number | undefined {
  const from = node.position?.start.offset;
  if (from === undefined || occurrence.at === undefined) return undefined;
  return from + occurrence.at;
}

/** The point of an absolute offset in the source, from the node's start position. */
function pointAt(node: InlineCode | Code, source: string, offset: number): Point | undefined {
  const start = node.position?.start;
  if (!start || start.offset === undefined || offset < start.offset) return undefined;
  return advance({ line: start.line, column: start.column }, source.slice(start.offset, offset), offset - start.offset);
}

/**
 * Where the content of a node starts, for the fallback when the document source is unavailable.
 * A fence's text starts on the line after its opening run; a code span's after its backticks,
 * whose count is read from the node's span when possible.
 */
function contentStart(node: InlineCode | Code): Point {
  const start = node.position?.start ?? { line: 1, column: 1 };
  if (node.type === "code") return { line: start.line + 1, column: start.column };
  let backticks = 1;
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from !== undefined && to !== undefined && !node.value.includes("\n")) {
    const pad = to - from - node.value.length;
    if (pad >= 2 && pad % 2 === 0) backticks = pad / 2;
  }
  return { line: start.line, column: start.column + backticks };
}

/** The records of one node's unescaped placeholders, in document order. */
function recordsOf(node: InlineCode | Code, source: string | undefined): Placeholder[] {
  const found = locate(node, source).filter((occurrence) => !occurrence.escaped);
  if (found.length === 0) return [];
  const kind = node.type === "code" ? "code" : "inline-code";
  const base = contentStart(node);
  const records: Placeholder[] = [];
  for (const occurrence of found) {
    const offset = sourceOffset(node, occurrence);
    const from = offset === undefined ? undefined : pointAt(node, source ?? "", offset);
    const endOffset = offset === undefined ? undefined : offset + occurrence.length - 1;
    const to = from && endOffset !== undefined ? pointAt(node, source ?? "", endOffset) : undefined;
    const start = from ?? advance(base, node.value, occurrence.index);
    const end = to ?? advance(base, node.value, occurrence.index + occurrence.length - 1);
    records.push({
      name: occurrence.name,
      kind,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    });
  }
  return records;
}

/** One hast span for an inline placeholder. */
function spanOf(name: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["placeholder"], "data-var": name },
    children: [{ type: "text", value: `{{${name}}}` }],
  };
}

/** The text before an occurrence with its escape backslash removed, if the value still carries one. */
function beforeOf(value: string, from: number, occurrence: Occurrence): string {
  const before = value.slice(from, occurrence.index);
  return occurrence.escaped && before.endsWith("\\") ? before.slice(0, -1) : before;
}

/** Drops the backslash that escapes each escaped placeholder, when the value still carries it. */
function unescape(value: string, found: readonly Occurrence[]): string {
  let out = "";
  let cursor = 0;
  for (const occurrence of found) {
    if (!occurrence.escaped || !value.slice(cursor, occurrence.index).endsWith("\\")) continue;
    out += value.slice(cursor, occurrence.index - 1);
    cursor = occurrence.index;
  }
  return out + value.slice(cursor);
}

/**
 * Rewrites inline code: placeholders become spans, escapes lose their backslash, and the node keeps
 * its type and position. `value` stays the visible text so headings and search read it unchanged.
 */
function transformInline(node: InlineCode, source: string | undefined): void {
  const found = locate(node, source);
  if (found.length === 0) return;
  const placeholders = found.filter((occurrence) => !occurrence.escaped);
  if (placeholders.length === 0) {
    node.value = unescape(node.value, found);
    return;
  }

  const children: ElementContent[] = [];
  let cursor = 0;
  for (const occurrence of found) {
    const text = beforeOf(node.value, cursor, occurrence);
    if (text !== "") {
      const part: Text = { type: "text", value: text };
      children.push(part);
    }
    if (occurrence.escaped) {
      const raw = node.value.slice(occurrence.index, occurrence.index + occurrence.length);
      const part: Text = { type: "text", value: raw };
      children.push(part);
    } else {
      children.push(spanOf(occurrence.name));
    }
    cursor = occurrence.index + occurrence.length;
  }
  const tail = node.value.slice(cursor);
  if (tail !== "") children.push({ type: "text", value: tail });

  node.value = unescape(node.value, found);
  const data = (node.data ?? {}) as Data;
  node.data = { ...data, hName: "code", hChildren: children };
}

/** Records a code block's placeholders on the node without touching its text. */
function transformBlock(node: Code, source: string | undefined): void {
  const records = recordsOf(node, source);
  if (records.length === 0) return;
  const items = records.map((record) => ({
    name: record.name,
    line: record.line,
    column: record.column,
    endLine: record.endLine,
    endColumn: record.endColumn,
  }));
  const data = (node.data ?? {}) as Data;
  const properties = { ...(data.hProperties ?? {}) };
  properties["data-placeholders"] = JSON.stringify(items);
  node.data = { ...data, hProperties: properties };
}

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/**
 * Every placeholder in a parsed page, in document order. `source` is the body the tree was parsed
 * from; passing it makes positions exact and lets an escaped `\{{name}}` in a code span be told
 * apart from a real placeholder.
 */
export function placeholdersIn(tree: Root, source?: string): readonly Placeholder[] {
  const found: Placeholder[] = [];
  visit(tree, (node) => {
    if (node.type === "inlineCode" || node.type === "code") {
      found.push(...recordsOf(node, source));
    }
  });
  return found;
}

/**
 * Every placeholder in a page, with positions in the page's source file. The model keeps the body
 * as `page.markdown`, so it is parsed again with the same parser the build used.
 */
export async function placeholdersOf(page: Page): Promise<readonly Placeholder[]> {
  const tree = await parseMarkdown(page.markdown, page.source.line);
  return placeholdersIn(tree, page.markdown);
}

export const name = "placeholders";
export const order = 15;
export const plugin: Plugin<[], Root> = () => (tree, file) => {
  const source = typeof file?.value === "string" ? file.value : undefined;
  visit(tree, (node) => {
    if (node.type === "inlineCode") transformInline(node, source);
    else if (node.type === "code") transformBlock(node, source);
  });
};
