import type { Data, Nodes, Paragraph, Parent, PhrasingContent, Root, TableCell, Text } from "mdast";
import type { Plugin } from "unified";
import type { Direction } from "../../contracts/index.ts";

/**
 * Isolates code and numbers inside right-to-left text.
 *
 * A Persian or Arabic sentence that holds a code span or a number can reorder its punctuation
 * around it: the neutral characters next to a left-to-right run take that run's direction under
 * the Unicode bidirectional algorithm. This plugin wraps those runs in `<span dir="ltr">…</span>`
 * so each one is an isolate and the surrounding sentence keeps its order:
 *
 * - Every inline code span in an RTL paragraph, list item, or table cell is wrapped.
 * - A numeric run is wrapped when the text on one of its sides is right-to-left, or when the
 *   whole run has no letters around it in its text node. Numbers inside a Latin phrase stay bare.
 * - Code blocks, headings, and left-to-right text are untouched.
 * - A block that already carries a raw HTML `dir` attribute is skipped, so nothing is wrapped
 *   twice. A second run of this plugin sees the isolation nodes it made and leaves them alone.
 *
 * The parser runs without the site config, so a plugin cannot read a page's `lang`. Direction is
 * taken from the first strong letter of each block, using the scripts behind the config's
 * right-to-left language list (`directionFromLang` in `content/lang.ts`). That keeps a Persian
 * quotation on an English page isolated and leaves an English quotation on a Persian page alone.
 *
 * The span is the theme's existing convention: the RTL stylesheet gives code `direction: ltr`
 * and `unicode-bidi: isolate`, and the doctor's bidi check treats an element with `dir` as an
 * isolate. `bdi` would isolate too but would not pin the direction of a run of digits.
 */

/** A right-to-left block created by this plugin: one `<span dir="ltr">` in the HTML. */
export interface BidiIsolation extends Parent {
  readonly type: "bidiIsolation";
  children: PhrasingContent[];
  data?: Data;
}

declare module "mdast" {
  interface PhrasingContentMap {
    bidiIsolation: BidiIsolation;
  }
  interface RootContentMap {
    bidiIsolation: BidiIsolation;
  }
}

/** The scripts the config's right-to-left languages are written in, one character at a time. */
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;

/** One letter, for the first-strong-character rule. Marks and digits are skipped. */
const LETTER = /^\p{L}$/u;

/** Every letter in a text node, in order, with its offset. */
const LETTERS = /\p{L}/gu;

/** A run of digits with its usual separators: `1`, `2.0`, `1,000`, `12:30`, `2024-11-10`, `3/4`. */
const NUMBER = /\p{Nd}+(?:[.,:/-]\p{Nd}+)*/gu;

/** A raw HTML tag that sets its own direction, which this plugin must not wrap again. */
const DIRECTIONAL_HTML = /\bdir\s*=/i;

/** The direction of a single letter. */
function directionOfLetter(letter: string): Direction {
  return RTL_SCRIPT.test(letter) ? "rtl" : "ltr";
}

/** The direction of the first strong letter in a text, or `undefined` when it has none. */
function directionOf(value: string): Direction | undefined {
  for (const letter of value.matchAll(LETTERS)) return directionOfLetter(letter[0]);
  return undefined;
}

/** The direction of the nearest strong letter on each side of the text slice `[from, to)`. */
function neighbours(value: string, from: number, to: number): { before: Direction | undefined; after: Direction | undefined } {
  let before: Direction | undefined;
  let after: Direction | undefined;
  for (const match of value.matchAll(LETTERS)) {
    const at = match.index ?? 0;
    if (at < from) before = directionOfLetter(match[0]);
    else if (at >= to) {
      after = directionOfLetter(match[0]);
      break;
    }
  }
  return { before, after };
}

/** One `<span dir="ltr">` node around inline content. */
function isolation(children: PhrasingContent[]): BidiIsolation {
  return {
    type: "bidiIsolation",
    data: { hName: "span", hProperties: { dir: "ltr" } },
    children,
  };
}

/** True when a block carries a raw HTML tag that sets a direction; that block is left as written. */
function hasDirectionalHtml(node: Nodes): boolean {
  if (node.type === "html") return DIRECTIONAL_HTML.test(node.value);
  if ("children" in node) return node.children.some(hasDirectionalHtml);
  return false;
}

/**
 * The direction of a block's first strong letter. Inline code is skipped: `npm` at the start of a
 * Persian sentence does not make the sentence left to right.
 */
function blockDirection(node: Nodes): Direction | undefined {
  if (node.type === "inlineCode" || node.type === "code" || node.type === "bidiIsolation") return undefined;
  if (node.type === "text") return directionOf(node.value);
  if ("children" in node) {
    for (const child of node.children) {
      const direction = blockDirection(child);
      if (direction !== undefined) return direction;
    }
  }
  return undefined;
}

/**
 * Splits a text node so each numeric run that reads right to left gets its own isolate.
 *
 * A run is isolated when the nearest letter before or after it is right to left, or when the text
 * node holds no letter at all (a block direction of RTL already says the run sits in RTL text).
 * A number inside a Latin phrase stays in the phrase.
 */
function isolateNumbers(node: Text): PhrasingContent[] {
  const value = node.value;
  const parts: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of value.matchAll(NUMBER)) {
    const from = match.index ?? 0;
    const run = match[0];
    const to = from + run.length;
    const { before, after } = neighbours(value, from, to);
    const rtl = before === "rtl" || after === "rtl" || (before === undefined && after === undefined);
    if (!rtl) continue;
    if (from > cursor) parts.push({ type: "text", value: value.slice(cursor, from) });
    parts.push(isolation([{ type: "text", value: run }]));
    cursor = to;
  }
  if (parts.length === 0) return [node];
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

/** True for the inline containers whose children keep the bidi context of the paragraph. */
function isInlineParent(node: PhrasingContent): node is Extract<PhrasingContent, Parent> {
  return node.type === "link" || node.type === "emphasis" || node.type === "strong" || node.type === "delete" || node.type === "linkReference";
}

/** Isolates one inline node: code spans, numeric runs, and the same inside inline containers. */
function isolateInline(node: PhrasingContent): PhrasingContent[] {
  if (node.type === "bidiIsolation") return [node];
  if (node.type === "text") return isolateNumbers(node);
  if (node.type === "inlineCode") return [isolation([node])];
  if (isInlineParent(node)) {
    node.children = node.children.flatMap(isolateInline);
    return [node];
  }
  return [node];
}

/** Isolates a block whose first strong letter is right to left, or whose enclosing block is. */
function isolateBlock(block: Paragraph | TableCell, inherited: Direction | undefined): void {
  if (hasDirectionalHtml(block)) return;
  const direction = blockDirection(block) ?? inherited;
  if (direction !== "rtl") return;
  block.children = block.children.flatMap(isolateInline);
}

/**
 * Isolates the paragraphs and table cells of a tree, in document order. A table or list gives its
 * direction to a cell or item with no letters of its own, so a numeric cell in a Persian table is
 * isolated too.
 */
function isolateTree(node: Nodes, inherited?: Direction): void {
  if (node.type === "paragraph" || node.type === "tableCell") isolateBlock(node, inherited);
  const context =
    node.type === "table" || node.type === "list" ? (blockDirection(node) ?? inherited) : inherited;
  if ("children" in node) {
    for (const child of node.children) isolateTree(child, context);
  }
}

export const name = "bidi-isolation";
export const order = 40;
export const plugin: Plugin<[], Root> = () => (tree) => {
  isolateTree(tree);
};
