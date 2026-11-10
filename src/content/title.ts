import { basename, extname } from "node:path";
import type { Heading, Nodes, Root } from "mdast";

/** The inputs {@link resolveTitle} reads for one page. */
export interface TitleInput {
  /** The front matter data from `parseFrontMatter`; `{}` when the page has none. */
  readonly frontMatter: Readonly<Record<string, unknown>>;
  /** The body parsed by `parseMarkdown`, with positions. */
  readonly tree: Root;
  /** The source file, relative to the site, such as `guide/install.md`. */
  readonly file: string;
}

/** A page's title and whether its body already supplies the `h1` that shows it. */
export interface ResolvedTitle {
  /** The page title, never empty. */
  readonly title: string;
  /**
   * True when the body has a top-level `h1`. The layout then skips its own `h1`, so a page shows
   * exactly one `h1` whether its title came from front matter or from the body.
   */
  readonly titleFromBody: boolean;
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

/** The first top-level `h1` of the body, or undefined when there is none. */
function firstH1(tree: Root): Heading | undefined {
  return tree.children.find((child): child is Heading => child.type === "heading" && child.depth === 1);
}

/** The file name without its extension: `guide/install.md` becomes `install`. */
function fileTitle(file: string): string {
  return basename(file, extname(file));
}

/**
 * Resolves a page's title in this order: the front matter `title` (a non-blank string or number),
 * then the text of the body's first top-level `h1`, then the file name.
 *
 * `titleFromBody` is true whenever the body has a top-level `h1`, even if front matter wins the title,
 * so the layout never renders a second `h1` above it.
 */
export function resolveTitle(input: TitleInput): ResolvedTitle {
  const h1 = firstH1(input.tree);
  const titleFromBody = h1 !== undefined;

  const fromFrontMatter = input.frontMatter.title;
  if (typeof fromFrontMatter === "string" || typeof fromFrontMatter === "number") {
    const text = String(fromFrontMatter).trim();
    if (text !== "") return { title: text, titleFromBody };
  }

  const fromHeading = h1 === undefined ? "" : textOf(h1).trim();
  if (fromHeading !== "") return { title: fromHeading, titleFromBody };

  return { title: fileTitle(input.file), titleFromBody };
}
