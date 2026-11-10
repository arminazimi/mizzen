import type { Nodes, Root } from "mdast";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { spanFromPosition } from "../source/spans.ts";
import { isAppPage } from "./app-pages.ts";

/** Where the map lands, relative to the output folder. */
const FILE = "sourcemap.json";

/** One heading of a page, as the source map records it. */
interface Section {
  /** The `id` the heading has in the built HTML. */
  readonly id: string;
  /** Heading level, 1 to 6. */
  readonly level: number;
  /** 1-based line in the source file, front matter included. */
  readonly line: number;
  /** 1-based column where the heading starts. */
  readonly column: number;
  /** 1-based line where the heading ends (the same as `line` for a one-line heading). */
  readonly endLine: number;
  /** Column of the heading's last character (inclusive). */
  readonly endColumn: number;
  /** The heading's plain text, as the built page shows it. */
  readonly text: string;
}

/** One link of a page: the target as written in the source, and the span it occupies. */
interface LinkEntry {
  /** The link target as written in the source. */
  readonly href: string;
  /** 1-based line in the source file, front matter included. */
  readonly line: number;
  /** 1-based column where the link starts. */
  readonly column: number;
  /** 1-based line where the link ends (the same as `line` for a one-line link). */
  readonly endLine: number;
  /** Column of the link's last character (inclusive). */
  readonly endColumn: number;
}

/** One page of the map. `sections` and `links` are always present, in document order. */
interface PageEntry {
  /** The page's URL path from the site root, as the model writes it. */
  readonly url: string;
  /** The source file, relative to the repository root, with forward slashes. */
  readonly source: string;
  /** Headings in document order. */
  readonly sections: readonly Section[];
  /** Links in document order. */
  readonly links: readonly LinkEntry[];
}

/** Walks the mdast tree in document (pre-order) order. */
function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** Every Markdown link in the page body, in document order, with its span in the source file. */
function linksOf(tree: Root, fallbackLine: number, file: string): LinkEntry[] {
  const links: LinkEntry[] = [];
  visit(tree, (node) => {
    if (node.type !== "link" || node.url === "") return;
    const span = node.position
      ? spanFromPosition(file, node.position)
      : { file, line: fallbackLine, column: 1, endLine: fallbackLine, endColumn: 1 };
    links.push({
      href: node.url,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
    });
  });
  return links;
}

/** The page's Markdown, the form that carries link positions. Other content is HTML and has no Markdown links. */
function isMarkdown(page: Page): boolean {
  return /\.(?:md|markdown)$/i.test(page.source.file);
}

/** A page's source file, relative to the repository root, with forward slashes on every platform. */
function sourcePath(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/**
 * Writes `sourcemap.json`: one entry per document page, naming its source file and,
 * for every heading and Markdown link, the 1-based line in the source that produced it.
 *
 * The positions are the ones the model kept. A page's headings already carry their source line, so sections read
 * `page.headings` directly. Links are inline nodes the model does not keep, so the output parses the page's Markdown
 * again with the same parser the model used; `page.source.line` is the line its body starts on, so positions come
 * back relative to the whole file, front matter included.
 *
 * App pages are left out: they are programs, not documents, and the spec's source map is about content. Pages are
 * sorted by URL and each list stays in document order, so the same model gives the same bytes.
 */
export const sourcemap: Output = {
  name: "sourcemap",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const options = { pages: site.pages };
    const pages: PageEntry[] = [];

    for (const page of site.pages) {
      if (page.kind !== "doc" || isAppPage(page.url, options)) continue;

      const sections: Section[] = page.headings.map((heading) => ({
        id: heading.id,
        level: heading.depth,
        line: heading.pos.line,
        column: heading.pos.column,
        endLine: heading.pos.endLine,
        endColumn: heading.pos.endColumn,
        text: heading.text,
      }));

      const links = isMarkdown(page)
        ? linksOf(await parseMarkdown(page.markdown, page.source.line), page.source.line, sourcePath(page))
        : [];

      pages.push({ url: page.url, source: sourcePath(page), sections, links });
    }

    const json = `${JSON.stringify({ version: 0, pages }, null, 2)}\n`;
    return [{ path: FILE, contents: json }];
  },
};
