import type { Properties } from "hast";
import type { Data, Nodes, Paragraph, Parent, Root, RootContent } from "mdast";
import type { Plugin } from "unified";

/**
 * Turns a `tabs` directive into semantic, JavaScript-free tab markup.
 *
 * ```md
 * :::::tabs{group="install"}
 * :::tab{label="macOS"}
 * Use Homebrew.
 * :::
 * ::tab[Linux]
 * :::::
 * ```
 *
 * The outer `tabs` container becomes `<div class="tabs" data-tabs-group="…">`, holding one
 * `div[role=tablist]` of `button[role=tab]` elements and one `div[role=tabpanel]` per tab. The
 * first tab is selected and the first panel is shown in the static HTML; the others are hidden.
 * Every tab and panel is linked by `aria-controls` and `aria-labelledby`.
 *
 * A tab label comes from its `label` attribute (`:::tab{label="macOS"}`), else from its directive
 * label (`:::tab[macOS]` or `::tab[macOS]`), else from its one-based position. Ids are the slugged
 * label plus the position, prefixed by the group key: the `group` attribute when present, else a
 * key made from the container's position in the page body (`tabs-<line>-<column>`). That makes
 * ids and keys deterministic and stable across builds of the same page.
 *
 * A group is malformed when it has no `tab` children or any child that is not a `tab`; a `tab`
 * outside a `tabs` group is malformed too. Malformed directives are left untouched, so the
 * directive stage still passes their content through and the page keeps reading.
 *
 * Non-`tabs` directives are untouched. The outer element keeps the container's source span, and
 * the tab bodies keep the spans of their own blocks.
 */

type Directive = Extract<RootContent, { type: "containerDirective" | "leafDirective" }>;

/**
 * One synthetic element of the tab markup. It is its own mdast type (not a `paragraph` or
 * `blockquote`) so later stages see a wrapper: the twin-parity gate walks into it instead of
 * treating the whole group as one block, and a label never becomes text.
 */
export interface TabsBlock extends Parent {
  readonly type: "tabsBlock";
  children: RootContent[];
  data?: Data;
}

declare module "mdast" {
  interface BlockContentMap {
    tabsBlock: TabsBlock;
  }
  interface RootContentMap {
    tabsBlock: TabsBlock;
  }
}

/** The directive label paragraph remark-directive puts first inside `:::name[label]`. */
function directiveLabelOf(node: Directive): Paragraph | undefined {
  if (node.type !== "containerDirective") return undefined;
  const first = node.children[0];
  if (first?.type !== "paragraph") return undefined;
  return first.data?.directiveLabel === true ? first : undefined;
}

/** Literal text a node renders with: text and inline code, not markup or breaks. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  let out = "";
  if ("children" in node) {
    for (const child of node.children) out += textOf(child as Nodes);
  }
  return out;
}

/** Lowercase, keep letters, digits, `_` and `-`, and join the rest with single hyphens. */
function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "tab"
  );
}

/** The label and body of one `tab` directive. The label paragraph is not part of the body. */
function tabOf(node: Directive, position: number): { label: string; body: RootContent[] } {
  const attribute = node.attributes?.label;
  let label = typeof attribute === "string" ? attribute.trim() : "";
  if (node.type === "leafDirective") {
    if (label === "") label = textOf(node).trim();
    return { label: label || String(position), body: [] };
  }
  const children = [...node.children] as RootContent[];
  const labelled = directiveLabelOf(node);
  if (labelled) {
    if (label === "") label = textOf(labelled).trim();
    children.shift();
  }
  return { label: label || String(position), body: children };
}

/** True for a `tab` directive, container or leaf form. */
function isTab(node: RootContent): node is Directive {
  return (node.type === "containerDirective" || node.type === "leafDirective") && node.name === "tab";
}

/** True for a `tabs` container directive. */
function isTabs(node: RootContent): node is Directive {
  return node.type === "containerDirective" && node.name === "tabs";
}

/** A wrapper that renders as `tagName`; `data.hName` turns its default `div` into the tag. */
function element(tagName: string, properties: Properties, children: RootContent[] = []): TabsBlock {
  return {
    type: "tabsBlock",
    children,
    data: { hName: tagName, hProperties: properties },
  };
}

/** Converts one valid `tabs` container into the tab markup; `key` is its group key. */
function buildTabs(node: Directive, key: string, base: string): TabsBlock {
  const tabs = node.children.map((child, index) => tabOf(child as Directive, index + 1));
  const names = tabs.map((tab, index) => `${base}-${slug(tab.label)}-${index + 1}`);

  const buttons = tabs.map((tab, index) => {
    const id = names[index] ?? base;
    return element("button", {
      type: "button",
      role: "tab",
      id,
      "aria-controls": `${id}-panel`,
      ...(index === 0 ? { "aria-selected": "true" } : {}),
      tabindex: index === 0 ? "0" : "-1",
    }, [{ type: "text", value: tab.label }]);
  });

  const panels = tabs.map((tab, index) => {
    const id = names[index] ?? base;
    return element(
      "div",
      {
        role: "tabpanel",
        id: `${id}-panel`,
        "aria-labelledby": id,
        ...(index === 0 ? {} : { hidden: true }),
      },
      tab.body,
    );
  });

  const outer = element(
    "div",
    { class: "tabs", "data-tabs-group": key },
    [element("div", { role: "tablist" }, buttons), ...panels],
  );
  if (node.position) outer.position = node.position;
  return outer;
}

/** Replaces every well-formed `tabs` group among a parent's children, then descends. */
function walk(parent: Parent, state: { fallback: number }): void {
  parent.children = parent.children.map((child): RootContent => {
    if (!isTabs(child)) return child;
    const children = child.children;
    if (children.length === 0 || !children.every((kid) => isTab(kid as RootContent))) return child;

    state.fallback += 1;
    const span = child.position
      ? `tabs-${child.position.start.line}-${child.position.start.column}`
      : `tabs-${state.fallback}`;
    const key = child.attributes?.group?.trim() || span;
    return buildTabs(child, key, slug(key));
  });
  for (const child of parent.children) {
    if ("children" in child) walk(child as Parent, state);
  }
}

export const name = "tabs";
export const order = 14;
export const plugin: Plugin<[], Root> = () => (tree) => {
  walk(tree, { fallback: 0 });
};
