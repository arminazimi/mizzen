import type { Nodes, Paragraph, Parent, Root, RootContent } from "mdast";
import type { Plugin } from "unified";

/**
 * Turns the short admonition directives into the callout component, before the directives unit
 * (order 20) writes them as `<sl-component>`:
 *
 *   :::note                → callout{ type="note" }
 *   :::tip[Read this]      → callout{ type="tip" title="Read this" }
 *   :::warning{title="…"}  → callout{ type="warning" title="…" }
 *   :::danger              → callout{ type="danger" }, which the theme reads as caution
 *
 * The name sets `type`; an explicit `type` attribute is overwritten, because the name is what the
 * author chose. Other attributes are kept. `[Title]` is the directive's label — the paragraph
 * `remark-directive` gives `data.directiveLabel` as the first child — and becomes `title` as plain
 * text: emphasis and code in a title are dropped, since the theme renders it as one string.
 *
 * Nothing else changes. `:::admonition` and `:::callout` keep their own attributes, every other
 * directive name passes through untouched, and code fences are not read. Nodes are edited in place,
 * so the position each one already has still becomes `data-src`.
 */

/** Container directive names this unit rewrites into the callout component. */
const ADMONITIONS: ReadonlySet<string> = new Set(["note", "tip", "warning", "danger"]);

export const name = "admonition";
export const order = 15;

type ContainerDirective = Extract<RootContent, { type: "containerDirective" }>;

/** A directive's label: the paragraph `remark-directive` marks with `data.directiveLabel`. */
function isLabel(node: Nodes): node is Paragraph {
  return (
    node.type === "paragraph" &&
    (node.data as { directiveLabel?: unknown } | undefined)?.directiveLabel === true
  );
}

/** The visible text of a label, with its inline markup flattened. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if ("children" in node) return node.children.map((child) => textOf(child as Nodes)).join("");
  return "";
}

/** Rewrites one `:::note`-style container in place: its name, its `type`, its `[Title]`, its children. */
function rewrite(node: ContainerDirective): void {
  const kind = node.name;
  const label = node.children.find(isLabel);
  const title = label ? textOf(label).trim() : "";
  const attributes: Record<string, string | null | undefined> = { ...(node.attributes ?? {}) };
  attributes.type = kind;
  if (title !== "") attributes.title = title;
  node.name = "callout";
  node.attributes = attributes;
  node.children = node.children.filter((child) => !isLabel(child));
}

/** Rewrites the admonitions among a parent's children, then descends into them. */
function walk(parent: Parent): void {
  parent.children = parent.children.map((child): RootContent => {
    const node = child as RootContent;
    if (node.type === "containerDirective" && ADMONITIONS.has(node.name)) rewrite(node);
    if ("children" in node) walk(node as Parent);
    return node;
  });
}

export const plugin: Plugin<[], Root> = () => (tree) => walk(tree);
