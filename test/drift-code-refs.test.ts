import assert from "node:assert/strict";
import { test } from "node:test";
import type { Root } from "mdast";
import type { Page } from "../src/contracts/content.ts";
import { codeRefsIn, codeRefsOf } from "../src/drift/code-refs.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";

/** Parses a body as a page in `file` starting at `bodyLine`, then reads its references. */
async function refsOf(body: string, file = "guide/setup.md", bodyLine = 1) {
  const tree: Root = await parseMarkdown(body, bodyLine);
  return codeRefsIn(tree, file);
}

test("prose references resolve from the page's folder and carry the node's source span", async () => {
  const body = "See src/foo.ts:48 for details.";
  const refs = await refsOf(body, "guide/setup.md", 4);
  assert.equal(refs.length, 1);
  const ref = refs[0]!;
  assert.equal(ref.path, "guide/src/foo.ts");
  assert.equal(ref.line, 48);
  assert.equal(ref.endLine, undefined);
  assert.equal(ref.column, undefined);
  assert.equal(ref.pos.file, "guide/setup.md");
  assert.equal(ref.pos.line, 4);
  assert.equal(ref.pos.column, 1);
  assert.equal(ref.pos.endLine, 4);
  // The directive parser splits `:48` into its own node; the span covers the text through that node.
  assert.equal(ref.pos.endColumn, "See src/foo.ts:48".length);
});

test("a leading slash anchors at the repository root", async () => {
  const [ref] = await refsOf("see /src/foo.ts:3:7");
  assert.equal(ref?.path, "src/foo.ts");
  assert.equal(ref?.line, 3);
  assert.equal(ref?.column, 7);
});

test(".. never climbs above the repository root", async () => {
  const [ref] = await refsOf("see ../../src/foo.ts:1", "guide/setup.md");
  assert.equal(ref?.path, "src/foo.ts");
});

test("inline code keeps the span of the whole code span", async () => {
  const body = "Use `src/foo.ts:48` now.";
  const [ref] = await refsOf(body);
  assert.equal(ref?.path, "guide/src/foo.ts");
  assert.equal(ref?.line, 48);
  const column = body.indexOf("`") + 1;
  assert.equal(ref?.pos.column, column);
  assert.equal(ref?.pos.endColumn, column + "src/foo.ts:48".length + 1);
});

test("link URLs are read, with #L ranges and a single #L line", async () => {
  const ranged = await refsOf("[a](../src/foo.ts#L3-L5)");
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0]?.path, "src/foo.ts");
  assert.equal(ranged[0]?.line, 3);
  assert.equal(ranged[0]?.endLine, 5);
  assert.equal(ranged[0]?.pos.column, 1);

  const point = await refsOf("[a](../src/foo.ts#L9)");
  assert.equal(point[0]?.line, 9);
  assert.equal(point[0]?.endLine, undefined);
});

test("colon ranges and columns are distinct forms", async () => {
  const refs = await refsOf("a src/a.ts:10-12 b src/b.ts:3:4 c src/c.ts:7");
  assert.deepEqual(
    refs.map((r) => [r.path, r.line, r.endLine, r.column]),
    [
      ["guide/src/a.ts", 10, 12, undefined],
      ["guide/src/b.ts", 3, undefined, 4],
      ["guide/src/c.ts", 7, undefined, undefined],
    ],
  );
});

test("fenced code is ignored unless the fence carries the bare test token", async () => {
  const body = [
    "```ts",
    "src/plain.ts:1",
    "```",
    "",
    "```ts test",
    "src/test.ts:2",
    "```",
    "",
    '```ts title="test"',
    "src/titled.ts:3",
    "```",
    "",
  ].join("\n");
  const refs = await refsOf(body);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.path, "guide/src/test.ts");
  assert.equal(refs[0]?.line, 2);
  assert.equal(refs[0]?.pos.line, 5);
  assert.equal(refs[0]?.pos.column, 1);
  assert.equal(refs[0]?.pos.endLine, 7);
  assert.equal(refs[0]?.pos.endColumn, 3);
});

test("the same reference at the same span is reported once; at another span it is kept", async () => {
  const oneNode = await refsOf("src/a.ts#L1 and src/a.ts#L1");
  assert.equal(oneNode.length, 1);

  const twoNodes = await refsOf("src/a.ts:1\n\nsrc/a.ts:1");
  assert.equal(twoNodes.length, 2);
  assert.equal(twoNodes[0]?.pos.line === twoNodes[1]?.pos.line, false);
});

test("references come in document order", async () => {
  const refs = await refsOf("src/b.ts:2 then src/a.ts:1");
  assert.deepEqual(refs.map((r) => r.path), ["guide/src/b.ts", "guide/src/a.ts"]);
});

test("bodyLine moves every span to the line in the source file", async () => {
  const [ref] = await refsOf("see `src/a.ts:2`", "guide/setup.md", 10);
  assert.equal(ref?.pos.line, 10);
  assert.equal(ref?.pos.endLine, 10);
});

test("a reference keeps its path and line when the page body moves down the file", async () => {
  const body = "See src/a.ts:12.";
  const [before] = await refsOf(body, "guide/setup.md", 1);
  const [after] = await refsOf(body, "guide/setup.md", 40);
  assert.equal(after?.path, before?.path);
  assert.equal(after?.line, before?.line);
  assert.equal(after?.pos.line, 40);
  assert.equal(after?.pos.endLine, 40);
});

test("a reference resolves from the page's current folder after the page is renamed", async () => {
  const [before] = await refsOf("src/a.ts:1", "old/guide/setup.md");
  const [after] = await refsOf("src/a.ts:1", "new/guide/setup.md");
  assert.equal(before?.path, "old/guide/src/a.ts");
  assert.equal(after?.path, "new/guide/src/a.ts");
});

test("prose that is not a path, URLs, and invalid lines are not references", async () => {
  const prose = await refsOf("note: 12 and src/a.ts:0 and src/a.ts:12bar");
  assert.equal(prose.length, 0);

  const url = await refsOf("see https://example.com/a.ts:10 for the file");
  assert.equal(url.length, 0);
});

test("without a page file a path stays as written and the span file is empty", async () => {
  const tree = await parseMarkdown("src/a.ts:4");
  const [ref] = codeRefsIn(tree);
  assert.equal(ref?.path, "src/a.ts");
  assert.equal(ref?.pos.file, "");
});

test("codeRefsOf parses the page body at page.source.line", async () => {
  const page: Page = {
    url: "/guide/",
    source: { file: "guide/setup.md", line: 4, column: 1, endLine: 4, endColumn: 1 },
    frontMatter: {},
    title: "Setup",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "see src/a.ts:2",
    kind: "doc",
  };
  const refs = await codeRefsOf(page);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.path, "guide/src/a.ts");
  assert.equal(refs[0]?.pos.line, 4);
});

test("an HTML page has no Markdown references", async () => {
  const page: Page = {
    url: "/app/",
    source: { file: "app/index.html", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "App",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "see src/a.ts:2",
    kind: "doc",
  };
  assert.deepEqual(await codeRefsOf(page), []);
});
