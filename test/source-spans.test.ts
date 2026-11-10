import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Page } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { buildModel } from "../src/model/build.ts";
import { sourcemap } from "../src/outputs/sourcemap.ts";
import { blockIdOf, formatSpan, parseSpan, sliceSpan, spanFromPosition, spanOf, spansIn } from "../src/source/spans.ts";

const fixture = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** The source map reads only the model; rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the source map never renders a page")),
  report: () => {},
};

/** The block types `to-html.ts` puts `data-src` on (ADR 0026). */
const BLOCKS = new Set([
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

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) for (const child of node.children) visit(child, visitFn);
}

/** Every block of a page, by the block ID its span starts at. */
function blocksOf(tree: Root, file: string): Map<string, Nodes> {
  const blocks = new Map<string, Nodes>();
  visit(tree, (node) => {
    if (!BLOCKS.has(node.type) || !node.position) return;
    blocks.set(blockIdOf(spanFromPosition(file, node.position)), node);
  });
  return blocks;
}

/** A page's source file as it is on disk, front matter included. */
function sourceOf(page: Page): string {
  return readFileSync(join(fixture, page.source.file), "utf8");
}

/** A page's Markdown body parsed like the model parses it; node offsets count from the body. */
async function treeOf(page: Page, source: string): Promise<{ tree: Root; body: string }> {
  const frontMatter = parseFrontMatter(source, page.source.file);
  return { tree: await parseMarkdown(frontMatter.body, frontMatter.bodyLine), body: frontMatter.body };
}

async function fixturePages(): Promise<readonly Page[]> {
  const { site, diagnostics } = await buildModel(fixture);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), [], "the fixture builds without errors");
  return site.pages.filter((page) => page.kind === "doc");
}

test("slicing a block's span returns exactly that block's Markdown", async () => {
  const pages = await fixturePages();
  assert.ok(pages.length > 0, "the fixture has doc pages");

  let blocks = 0;
  for (const page of pages) {
    const source = sourceOf(page);
    const { tree, body } = await treeOf(page, source);
    const nodes = blocksOf(tree, page.source.file);
    const spans = spansIn(page.html);

    for (const span of spans) {
      const node = nodes.get(blockIdOf(span));
      assert.ok(node, `${page.url} has a block at ${blockIdOf(span)}`);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      assert.ok(start !== undefined && end !== undefined, `${blockIdOf(span)} has offsets`);

      const fromSpan = sliceSpan(source, span);
      const fromOffsets = body.slice(start, end);
      assert.equal(fromSpan, fromOffsets, `${blockIdOf(span)} slices to its block's Markdown`);
      assert.ok(fromSpan.length > 0, `${blockIdOf(span)} is not empty`);
      blocks += 1;
    }

    // Every top-level block is rendered; a tight list's inner paragraphs are folded into their `<li>`,
    // so only the top level is expected to have an element of its own.
    for (const node of tree.children) {
      if (!node.position) continue;
      const id = blockIdOf(spanFromPosition(page.source.file, node.position));
      assert.ok(
        spans.some((span) => blockIdOf(span) === id),
        `${page.url} emits a block at ${id}`,
      );
    }
  }

  assert.ok(blocks > 100, `every block of the fixture is covered (${blocks})`);
});

test("two builds give the same block IDs and spans", async () => {
  const first = await buildModel(fixture);
  const second = await buildModel(fixture);
  assert.deepEqual(
    first.site.pages.map((page) => spansIn(page.html).map(formatSpan)),
    second.site.pages.map((page) => spansIn(page.html).map(formatSpan)),
  );
  assert.deepEqual(
    (await sourcemap.run(first.site, ctx)).map((file) => String(file.contents)),
    (await sourcemap.run(second.site, ctx)).map((file) => String(file.contents)),
  );
});

test("the source map records a column and an end on every section and link", async () => {
  const { site } = await buildModel(fixture);
  const file = (await sourcemap.run(site, ctx)).find((entry) => entry.path === "sourcemap.json");
  assert.ok(file, "the output writes sourcemap.json");
  const map = JSON.parse(String(file.contents)) as {
    pages: {
      url: string;
      sections: { id: string; line: number; column: number; endLine: number; endColumn: number }[];
      links: { href: string; line: number; column: number; endLine: number; endColumn: number }[];
    }[];
  };

  let sections = 0;
  let links = 0;
  for (const page of map.pages) {
    for (const section of page.sections) {
      assert.ok(section.column >= 1, `${page.url} section ${section.id} column`);
      assert.ok(section.endLine >= section.line, `${page.url} section ${section.id} end line`);
      assert.ok(
        section.endLine > section.line || section.endColumn >= section.column,
        `${page.url} section ${section.id} end column`,
      );
      sections += 1;
    }
    for (const link of page.links) {
      assert.ok(link.column >= 1, `${page.url} link ${link.href} column`);
      assert.ok(link.endLine >= link.line, `${page.url} link ${link.href} end line`);
      assert.ok(link.endColumn >= 1, `${page.url} link ${link.href} end column`);
      links += 1;
    }
  }
  assert.ok(sections > 0, "the fixture has sections");
  assert.ok(links > 0, "the fixture has links");

  const install = map.pages.find((page) => page.url === "/install/");
  assert.ok(install, "the fixture has /install/");
  const heading = install.sections.find((section) => section.id === "install");
  assert.deepEqual(
    { line: heading?.line, column: heading?.column, endLine: heading?.endLine, endColumn: heading?.endColumn },
    { line: 7, column: 1, endLine: 7, endColumn: 9 },
    "# Install is line 7, columns 1 to 9",
  );
});

test("spanOf finds a block's span from its ID in the page's HTML", () => {
  const html =
    '<h1 data-src="docs/a.md:1:1-1:9">A</h1>' +
    '<p data-src="docs/a.md:3:1-4:7">Text</p>' +
    '<pre data-src="docs/a.md:6:1-8:3"><code>x</code></pre>';
  assert.deepEqual(spanOf("docs/a.md:1:1", html), { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 9 });
  assert.deepEqual(spanOf("docs/a.md:3:1", html), { file: "docs/a.md", line: 3, column: 1, endLine: 4, endColumn: 7 });
  assert.equal(spanOf("docs/a.md:9:1", html), undefined);
  assert.deepEqual(spanOf("docs/a.md:3:1", spansIn(html)), { file: "docs/a.md", line: 3, column: 1, endLine: 4, endColumn: 7 });
});

test("a span and a block ID round-trip, and point forms stay points", () => {
  const span = { file: "docs/a.md", line: 12, column: 3, endLine: 14, endColumn: 5 };
  assert.equal(formatSpan(span), "docs/a.md:12:3-14:5");
  assert.deepEqual(parseSpan(formatSpan(span)), span);
  assert.equal(blockIdOf(span), "docs/a.md:12:3");

  assert.deepEqual(parseSpan("docs/a.md:12"), { file: "docs/a.md", line: 12, column: 1, endLine: 12, endColumn: 1 });
  assert.deepEqual(parseSpan("docs/a.md:12:3"), { file: "docs/a.md", line: 12, column: 3, endLine: 12, endColumn: 3 });

  assert.deepEqual(parseSpan("docs/a:b.md:12:3-14:5"), {
    file: "docs/a:b.md",
    line: 12,
    column: 3,
    endLine: 14,
    endColumn: 5,
  });

  assert.equal(parseSpan("docs/a.md:0"), undefined);
  assert.equal(parseSpan("docs/a.md"), undefined);
  assert.equal(parseSpan(""), undefined);
});

test("sliceSpan keeps the text between the two positions and nothing around it", () => {
  const source = "one\ntwo three\nfour\nfive\n";
  assert.equal(
    sliceSpan(source, { file: "a.md", line: 2, column: 5, endLine: 4, endColumn: 4 }),
    "three\nfour\nfive",
  );
  assert.equal(sliceSpan(source, { file: "a.md", line: 2, column: 5, endLine: 2, endColumn: 9 }), "three");
  assert.equal(sliceSpan(source, { file: "a.md", line: 5, column: 1, endLine: 5, endColumn: 1 }), "");
});
