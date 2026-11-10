import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Link, List, Nodes, Root, Table, Text } from "mdast";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function firstOfType<T extends Nodes["type"]>(tree: Root, type: T): Extract<Nodes, { type: T }> {
  let found: Extract<Nodes, { type: T }> | undefined;
  visit(tree, (n) => {
    if (!found && n.type === type) found = n as Extract<Nodes, { type: T }>;
  });
  assert.ok(found, `expected a ${type} node`);
  return found;
}

test("plugins are discovered from the folder and sorted by order then name", async () => {
  const plugins = await loadMarkdownPlugins();
  assert.ok(plugins.some((p) => p.name === "gfm"));
  assert.deepEqual(
    plugins.map((p) => p.name),
    [...plugins].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => p.name),
  );
  assert.equal(plugins[0]?.name, "gfm");
  assert.equal(plugins[0]?.order, 0);
});

test("headings keep positions, offset by bodyLine", async () => {
  const body = "# Title\n\nparagraph\n";
  const tree = await parseMarkdown(body, 5);
  const heading = firstOfType(tree, "heading") as Heading;
  assert.equal(heading.depth, 1);
  assert.equal((heading.children[0] as Text).value, "Title");
  assert.equal(heading.position?.start.line, 5);
  assert.equal(heading.position?.start.column, 1);
  const paragraph = firstOfType(tree, "paragraph");
  assert.equal(paragraph.position?.start.line, 7);
});

test("bodyLine 1 leaves positions as remark reports them", async () => {
  const tree = await parseMarkdown("# A\n", 1);
  assert.equal(firstOfType(tree, "heading").position?.start.line, 1);
});

test("GFM: table, task list, strikethrough, and autolink", async () => {
  const body = [
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- [x] done",
    "",
    "~~old~~",
    "",
    "See https://example.com.",
    "",
  ].join("\n");
  const tree = await parseMarkdown(body, 1);

  const table = firstOfType(tree, "table") as Table;
  assert.equal(table.children.length, 2);

  const list = firstOfType(tree, "list") as List;
  assert.equal(list.children[0]?.checked, true);

  let strike = false;
  let autolink = false;
  visit(tree, (n) => {
    if (n.type === "delete") strike = true;
    if (n.type === "link") {
      const link = n as Link;
      if (link.url === "https://example.com") autolink = true;
    }
  });
  assert.equal(strike, true);
  assert.equal(autolink, true);
});
