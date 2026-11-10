import type { BlockContent, Code, Data, Image, ImageReference, Nodes, Paragraph, Parent, Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic } from "../../contracts/index.ts";
import { spanFromPosition } from "../../source/spans.ts";

/**
 * Turns a `figure` directive into a semantic `<figure>` with a `<figcaption>`:
 *
 * ```md
 * :::figure{#pipeline caption="The eight build stages"}
 * ![The pipeline](/img/pipeline.svg)
 * :::
 * ```
 *
 * The body is either one Markdown image (`![alt](src)`, including a reference image) or one
 * fenced code block. The result is `<figure id="pipeline">` holding the image or the code block,
 * followed by `<figcaption>The eight build stages</figcaption>`. The directive keeps its source
 * span, so the figure gets `data-src` like every other block.
 *
 * - `id` is the figure's id for linking. Without it the figure has no id.
 * - `caption` is the figcaption's text, taken literally (it is not parsed as Markdown). A
 *   directive label (`:::figure[The pipeline]`) is the fallback. Without either, the figure has
 *   no figcaption.
 * - An image needs alt text. When it has none, the plugin reports {@link MISSING_ALT} through
 *   {@link figureDiagnostics}, leaves the directive's content in place without a `<figure>`, and
 *   so never renders a broken figure. A code block needs no alt text.
 * - A body that is neither one image nor one code block is not a figure; its content is left in
 *   place, without a `<figure>`, and it reports nothing.
 *
 * This unit runs after the directives unit (order 20), which first writes every directive as
 * `<sl-component>`; here a well-formed figure replaces that element with the semantic one.
 * Rendering is logical only: `<figure>` and `<figcaption>` are direction-neutral, so the same
 * markup serves left-to-right and right-to-left pages without any physical CSS.
 */

/** Stable diagnostic code for a figure image with no alt text. */
export const MISSING_ALT = "figure.missing-alt";

/** The data this plugin puts on a `figure` directive. */
export interface FigureData extends Data {
  figure: {
    /** The `id` attribute, trimmed; empty when absent. */
    id: string;
    /** The caption, when there is one. */
    caption?: string;
    /** Why no figure was rendered; absent for a rendered figure. */
    problem?: typeof MISSING_ALT;
  };
}

type ContainerDirective = Extract<RootContent, { type: "containerDirective" }>;
type FigureImage = Image | ImageReference;

/** A directive's label: the paragraph `remark-directive` marks with `data.directiveLabel`. */
function isLabel(node: Nodes): node is Paragraph {
  return (
    node.type === "paragraph" &&
    (node.data as { directiveLabel?: unknown } | undefined)?.directiveLabel === true
  );
}

/** True for an image the directive body may hold: inline image or reference image. */
function isImage(node: Nodes): node is FigureImage {
  return node.type === "image" || node.type === "imageReference";
}

/** The visible text of a label, with its inline markup flattened. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if ("children" in node) return node.children.map((child) => textOf(child as Nodes)).join("");
  return "";
}

/** A trimmed string attribute, or "" when it is absent or valueless. */
function attribute(node: ContainerDirective, name: string): string {
  const value = node.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The one image or code block a figure body holds, if that is all it holds. The directive label
 * is not part of the body, and whitespace-only text around an image is ignored.
 */
function contentOf(node: ContainerDirective): FigureImage | Code | undefined {
  // The explicit `boolean` keeps TypeScript from narrowing `paragraph` away: the label test is
  // about one child, not about excluding paragraphs from the body.
  const body = node.children.filter((child): boolean => !isLabel(child));
  if (body.length !== 1) return undefined;
  const only = body[0];
  if (only === undefined) return undefined;
  if (only.type === "code") return only;
  if (only.type !== "paragraph") return undefined;
  const inline = only.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  const first = inline[0];
  return inline.length === 1 && first !== undefined && isImage(first) ? first : undefined;
}

/** The caption from the `caption` attribute, else from the directive label, else "". */
function captionOf(node: ContainerDirective): string {
  const explicit = attribute(node, "caption");
  if (explicit !== "") return explicit;
  const label = node.children.find(isLabel);
  return label ? textOf(label).trim() : "";
}

/** A `<figcaption>` element with `caption` as its literal text. It has no span of its own. */
function figcaption(caption: string): Paragraph {
  return {
    type: "paragraph",
    data: { hName: "figcaption" },
    children: [{ type: "text", value: caption }],
  };
}

/** Renders a well-formed figure: the semantic element, its content, and its caption. */
function build(node: ContainerDirective, content: FigureImage | Code, id: string, caption: string): void {
  const data = (node.data ??= {}) as FigureData;
  data.hName = "figure";
  data.hProperties = id === "" ? {} : { id };
  data.figure = caption === "" ? { id } : { id, caption };
  // An image is phrasing content; hoisted out of its paragraph it is still valid flow content
  // inside `<figure>`, which is what gives `<figure><img>…<figcaption>`.
  const children: ContainerDirective["children"] = [content as unknown as BlockContent];
  if (caption !== "") children.push(figcaption(caption));
  node.children = children;
}

/**
 * Leaves a directive that is not a well-formed figure as ordinary content: no `<figure>`, no
 * `<figcaption>`, and no source span of its own beyond the blocks inside it.
 */
function unfigure(
  node: ContainerDirective,
  figure: FigureData["figure"],
  children: ContainerDirective["children"],
): void {
  const data = (node.data ??= {}) as FigureData;
  delete data.hName;
  delete data.hProperties;
  data.figure = figure;
  node.children = children;
}

/** Converts one `figure` directive in place, whether it becomes a figure or stays content. */
function transform(node: ContainerDirective): void {
  const content = contentOf(node);
  const id = attribute(node, "id");
  const caption = captionOf(node);
  const children = node.children.filter((child): boolean => !isLabel(child));
  const summary = caption === "" ? { id } : { id, caption };

  if (content === undefined) {
    unfigure(node, summary, children);
    return;
  }
  if (isImage(content) && (content.alt ?? "").trim() === "") {
    unfigure(node, { ...summary, problem: MISSING_ALT }, children);
    return;
  }
  build(node, content, id, caption);
}

/** Converts every `figure` directive among a parent's children, then descends into them. */
function walk(parent: Parent): void {
  parent.children = parent.children.map((child): RootContent => {
    if (child.type === "containerDirective" && child.name === "figure") transform(child);
    if ("children" in child) walk(child as Parent);
    return child;
  });
}

/** Walks the tree in document order. */
function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/**
 * Reports every figure image without alt text in `tree`, in document order, with the directive's
 * source span. `file` is the page's source path, relative to the site, as `Page.source.file`
 * gives it. The plugin itself never renders a broken figure, so these are the only findings it
 * records; a build reports them by calling this function after parsing.
 */
export function figureDiagnostics(tree: Root, file: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(tree, (node) => {
    if (node.type !== "containerDirective" || node.name !== "figure") return;
    const figure = (node.data as FigureData | undefined)?.figure;
    if (figure?.problem !== MISSING_ALT) return;
    diagnostics.push({
      id: MISSING_ALT,
      severity: "warning",
      message: "The figure's image has no alt text; describe the image in ![alt](src).",
      ...(node.position ? { pos: spanFromPosition(file, node.position) } : {}),
      help: "Write ![describe the image](/path/to/image.png), or use a code block instead.",
    });
  });
  return diagnostics;
}

export const name = "figure";
export const order = 21;
export const plugin: Plugin<[], Root> = () => (tree) => {
  walk(tree);
};
