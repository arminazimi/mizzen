import type { Element, Nodes as HastNodes, Root as HastRoot } from "hast";
import type { Heading, Nodes, Root } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { formatSpan, spanFromPosition } from "../source/spans.ts";

/**
 * Turns a parsed page (mdast, from `parseMarkdown`) into HTML, and stamps every block element with
 * the source span it came from.
 *
 * Each block element (heading, paragraph, list, table, code block, blockquote, and directive
 * component) gets `data-src="<path>:<line>:<column>-<endLine>:<endColumn>"`, the block's full span
 * from the first character to the last (ADR 0026). That attribute is the base of source maps and
 * edit prompts, and its start is the block's ID. Raw HTML in the Markdown is passed through
 * unchanged (`allowDangerousHtml`).
 *
 * The page's headings are collected in document order from its top-level children (the same
 * scope the slug plugin gives ids to): depth, plain text, and the anchor id.
 */

/** Block node types that carry `data-src`. Directive types come from remark-directive when it lands. */
const SOURCED = new Set([
  "heading",
  "paragraph",
  "list",
  "table",
  "code",
  "blockquote",
  "containerDirective",
  "leafDirective",
  "tabsBlock",
]);

/** A heading of the page, for the table of contents. */
export interface PageHeading {
  readonly depth: number;
  readonly text: string;
  readonly id: string;
}

/** The HTML of one page and the headings it contains. */
export interface PageHtml {
  readonly html: string;
  readonly headings: readonly PageHeading[];
}

const processor = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true })
  .freeze();

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** Sets `data-src` on each sourced block, read by remark-rehype through `data.hProperties`. */
function stampSources(tree: Root, sourcePath: string): void {
  visit(tree, (node) => {
    if (!SOURCED.has(node.type) || !node.position) return;
    const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
    data.hProperties = {
      ...data.hProperties,
      "data-src": formatSpan(spanFromPosition(sourcePath, node.position)),
    };
  });
}

/**
 * A code block's `data-src` lands on its inner `<code>`, because mdast-util-to-hast applies a
 * node's properties to the element it builds first. The code block is the `<pre>`, so the
 * attribute moves up to it.
 */
function moveCodeSource(node: HastNodes): void {
  if (node.type === "element" && node.tagName === "pre") {
    const code = node.children.find(
      (child): child is Element => child.type === "element" && child.tagName === "code",
    );
    const src = code?.properties["data-src"];
    if (code && src !== undefined) {
      node.properties["data-src"] = src;
      delete code.properties["data-src"];
    }
  }
  if ("children" in node) {
    for (const child of node.children) moveCodeSource(child);
  }
}

/** Concatenates the literal text a node renders with: text and code, not markup or breaks. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  let out = "";
  if ("children" in node) {
    for (const child of node.children) out += textOf(child);
  }
  return out;
}

function collectHeadings(tree: Root): PageHeading[] {
  const headings: PageHeading[] = [];
  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    const heading = node as Heading;
    const id = (heading.data as { id?: string } | undefined)?.id ?? "";
    headings.push({ depth: heading.depth, text: textOf(heading), id });
  }
  return headings;
}

/**
 * Converts a parsed page to HTML and collects its headings.
 *
 * `sourcePath` is the page's source file relative to the site (for example `guide/install.md`);
 * it is written into every `data-src`. The input tree is not modified.
 */
export async function markdownToHtml(tree: Root, sourcePath: string): Promise<PageHtml> {
  const headings = collectHeadings(tree);
  const stamped = structuredClone(tree);
  stampSources(stamped, sourcePath);
  const hast = (await processor.run(stamped)) as HastRoot;
  moveCodeSource(hast);
  return { html: processor.stringify(hast), headings };
}
