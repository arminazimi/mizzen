import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Root } from "mdast";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/** Every element that carries `data-src`, in document order, as `tag` and its full span. */
function sourced(html: string): { tag: string; src: string }[] {
  const out: { tag: string; src: string }[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\sdata-src="([^"]*)"/g)) {
    out.push({ tag: match[1] ?? "", src: match[2] ?? "" });
  }
  return out;
}

const SAMPLE = [
  "# Install", // 4
  "",
  "Run the installer.", // 6
  "",
  "## Steps", // 8
  "",
  "- first", // 10
  "- second",
  "",
  "1. one", // 13
  "",
  "| a | b |", // 15
  "| - | - |",
  "| 1 | 2 |",
  "",
  "> quoted", // 19
  "",
  "```ts", // 21
  "const x = 1;",
  "```",
  "",
  "<aside>raw</aside>", // 25: raw HTML, not a stamped block
  "",
  "Last line.", // 27
];

test("every block element in a sample page carries its full source span", async () => {
  const tree = await parseMarkdown(SAMPLE.join("\n"), 4);
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.deepEqual(sourced(html), [
    { tag: "h1", src: "guide/install.md:4:1-4:9" },
    { tag: "p", src: "guide/install.md:6:1-6:18" },
    { tag: "h2", src: "guide/install.md:8:1-8:8" },
    { tag: "ul", src: "guide/install.md:10:1-11:8" },
    { tag: "ol", src: "guide/install.md:13:1-13:6" },
    { tag: "table", src: "guide/install.md:15:1-17:9" },
    { tag: "blockquote", src: "guide/install.md:19:1-19:8" },
    { tag: "p", src: "guide/install.md:19:3-19:8" },
    { tag: "pre", src: "guide/install.md:21:1-23:3" },
    { tag: "p", src: "guide/install.md:27:1-27:10" },
  ]);
});

test("a page parsed from line 1 stamps spans as remark reports them", async () => {
  const tree = await parseMarkdown("# A\n\nText.\n", 1);
  const { html } = await markdownToHtml(tree, "a.md");
  assert.deepEqual(sourced(html), [
    { tag: "h1", src: "a.md:1:1-1:3" },
    { tag: "p", src: "a.md:3:1-3:5" },
  ]);
});

test("directive components carry data-src", async () => {
  const position = (line: number) => ({
    start: { line, column: 1, offset: 0 },
    end: { line, column: 1, offset: 0 },
  });
  const tree = {
    type: "root",
    children: [
      {
        type: "containerDirective",
        name: "note",
        attributes: {},
        position: { start: { line: 7, column: 1, offset: 0 }, end: { line: 9, column: 1, offset: 0 } },
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "Careful." }],
            position: position(8),
          },
        ],
      },
    ],
  } as unknown as Root;
  const { html } = await markdownToHtml(tree, "guide/tips.md");
  assert.deepEqual(sourced(html), [
    { tag: "div", src: "guide/tips.md:7:1-9:1" },
    { tag: "p", src: "guide/tips.md:8:1-8:1" },
  ]);
});

test("raw HTML in the Markdown passes through unchanged", async () => {
  const tree = await parseMarkdown("<aside class=\"note\">raw</aside>\n", 1);
  const { html } = await markdownToHtml(tree, "a.md");
  assert.match(html, /<aside class="note">raw<\/aside>/);
});

test("headings are collected with depth, text, and id", async () => {
  const tree = await parseMarkdown("# Install\n\n## نصب و راه‌اندازی\n\n### Code `x` {#custom}\n\n## Install\n", 1);
  const { headings, html } = await markdownToHtml(tree, "a.md");
  assert.deepEqual(headings, [
    { depth: 1, text: "Install", id: "install" },
    { depth: 2, text: "نصب و راه‌اندازی", id: "نصب-و-راهاندازی" },
    { depth: 3, text: "Code x", id: "custom" },
    { depth: 2, text: "Install", id: "install-1" },
  ]);
  assert.match(html, /<h1 id="install" data-src="a\.md:1:1-1:9">Install<\/h1>/);
});

test("a custom heading id is collected and rendered, with the custom id stripped from the text", async () => {
  const tree = await parseMarkdown("## نصب {#install}\n", 1);
  const { headings, html } = await markdownToHtml(tree, "a.md");
  assert.deepEqual(headings, [{ depth: 2, text: "نصب", id: "install" }]);
  assert.match(html, /<h2 id="install" data-src="a\.md:1:1-1:17">نصب<\/h2>/);
});

test("the input tree is not modified", async () => {
  const tree = await parseMarkdown("# Title\n\nBody.\n", 1);
  const before = JSON.stringify(tree);
  await markdownToHtml(tree, "a.md");
  assert.equal(JSON.stringify(tree), before);
  const heading = tree.children[0] as Heading;
  assert.equal((heading.data as { hProperties?: Record<string, unknown> }).hProperties?.["data-src"], undefined);
});
