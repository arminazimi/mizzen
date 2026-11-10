import assert from "node:assert/strict";
import { test } from "node:test";
import type { Code, Nodes, Root } from "mdast";
import type { Page } from "../src/contracts/index.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import {
  examplesIn,
  examplesOf,
  isExampleMeta,
  type MarkdownExample,
} from "../src/markdown/plugins/example-fence.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/**
 * The fixture page: two examples and one plain fence. The first example is followed by its
 * `output` fence; the second has none. The fences sit on lines 3–5, 13–15, and 17–19.
 */
const PAGE = [
  "# Examples", // 1
  "",
  "```ts test", // 3
  'console.log("one");',
  "```",
  "",
  "```output", // 7
  "one",
  "```",
  "",
  "A plain fence stays plain.", // 11
  "",
  "```ts", // 13
  "const plain = 1;",
  "```",
  "",
  "```bash test", // 17
  "npm ci",
  "```",
  "",
].join("\n");

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function codesIn(tree: Root): Code[] {
  const codes: Code[] = [];
  visit(tree, (node) => {
    if (node.type === "code") codes.push(node);
  });
  return codes;
}

/** The page object `examplesOf` reads, with the body starting on line 4 as after front matter. */
function pageOf(markdown: string, line = 4): Page {
  return {
    url: "/examples/",
    source: { file: "guide/examples.md", line, column: 1, endLine: line + markdown.split("\n").length - 1, endColumn: 1 },
    frontMatter: {},
    title: "Examples",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

test("example-fence is discovered after code and before directives", async () => {
  const plugins = await loadMarkdownPlugins();
  const unit = plugins.find((plugin) => plugin.name === "example-fence");
  assert.ok(unit, "the example-fence plugin is discovered from the plugins folder");
  assert.equal(unit?.order, 15);
  assert.ok(plugins.findIndex((plugin) => plugin.name === "code") < plugins.indexOf(unit));
  assert.ok(plugins.findIndex((plugin) => plugin.name === "directives") > plugins.indexOf(unit));
});

test("a bare test token marks an example; quotes, prefixes, and values do not", () => {
  assert.equal(isExampleMeta("test"), true);
  assert.equal(isExampleMeta('title="a.ts" test'), true);
  assert.equal(isExampleMeta("test showLineNumbers"), true);
  assert.equal(isExampleMeta('title="test"'), false, "a quoted value is not the flag");
  assert.equal(isExampleMeta("testify"), false);
  assert.equal(isExampleMeta("test=true"), false);
  assert.equal(isExampleMeta("{test}"), false);
  assert.equal(isExampleMeta(""), false);
  assert.equal(isExampleMeta(null), false);
});

test("the fixture page exposes its two examples and leaves the plain fence alone", async () => {
  const tree = await parseMarkdown(PAGE, 1);
  const examples = examplesIn(tree);
  assert.equal(examples.length, 2, "two fences carry the test meta");

  const [first, second] = examples;
  assert.deepEqual(first, {
    id: "example-1",
    lang: "ts",
    code: 'console.log("one");',
    expected: "one",
    pos: { line: 3, column: 1, endLine: 5, endColumn: 3 },
  });
  assert.deepEqual(second, {
    id: "example-2",
    lang: "bash",
    code: "npm ci",
    expected: null,
    pos: { line: 17, column: 1, endLine: 19, endColumn: 3 },
  });

  const plain = codesIn(tree).find((code) => code.value === "const plain = 1;");
  assert.ok(plain);
  assert.equal(plain.lang, "ts");
  assert.equal(plain.value, "const plain = 1;");
  assert.deepEqual((plain.data as Record<string, unknown> | undefined)?.example, undefined);
  assert.equal((plain.data as { hProperties?: unknown } | undefined)?.hProperties, undefined);
});

test("expected output comes only from an adjacent output fence", async () => {
  const tree = await parseMarkdown(
    [
      "```ts test", // 1
      "a",
      "```",
      "```output", // 4
      "first",
      "```",
      "",
      "```ts test", // 8
      "b",
      "```",
      "",
      "Not adjacent: this paragraph comes first.",
      "",
      "```output", // 14
      "ignored",
      "```",
      "",
      "```ts test", // 18
      "c",
      "```",
      "```ts",
      "not output",
      "```",
      "",
    ].join("\n"),
  );
  const examples = examplesIn(tree);
  assert.deepEqual(
    examples.map((example) => example.expected),
    ["first", null, null],
  );
});

test("a plain fence immediately before an output fence does not take it", async () => {
  const tree = await parseMarkdown("```ts\nplain\n```\n```output\nout\n```\n");
  assert.deepEqual(examplesIn(tree), []);
  const output = codesIn(tree)[1];
  assert.equal(output?.value, "out");
  assert.equal((output?.data as Record<string, unknown> | undefined)?.example, undefined);
});

test("ids are stable for the same source and unique within a page", async () => {
  const one = examplesIn(await parseMarkdown(PAGE, 1));
  const two = examplesIn(await parseMarkdown(PAGE, 1));
  assert.deepEqual(
    one.map((example) => example.id),
    two.map((example) => example.id),
  );
  assert.equal(new Set(one.map((example) => example.id)).size, one.length);
});

test("fences without test render byte for byte as before", async () => {
  const tree = await parseMarkdown("```ts\nconst a = 1;\n```\n", 1);
  const { html } = await markdownToHtml(tree, "a.md");
  assert.equal(html, '<pre data-src="a.md:1:1-3:3"><code class="language-ts">const a = 1;\n</code></pre>');
});

test("an example carries its record and data-example attributes; its output fence stays plain", async () => {
  const tree = await parseMarkdown(PAGE, 1);
  const { html } = await markdownToHtml(tree, "guide/examples.md");
  assert.match(
    html,
    /<code class="language-ts" data-example="true" data-example-lang="ts" data-example-id="example-1">console\.log\("one"\);/,
  );
  assert.match(html, /<code class="language-output">one\n<\/code>/);
  assert.equal((html.match(/data-example=/g) ?? []).length, 2, "only the two examples are marked");
  const output = codesIn(tree)[1];
  assert.equal(output?.lang, "output");
  assert.equal((output?.data as { example?: unknown } | undefined)?.example, undefined);
});

test("examplesOf re-parses the page body from its source line and names the file", async () => {
  const examples: MarkdownExample[] = await examplesOf(pageOf(PAGE));
  assert.deepEqual(
    examples.map((example) => example.id),
    ["example-1", "example-2"],
  );
  assert.deepEqual(examples[0]?.pos, {
    file: "guide/examples.md",
    line: 6,
    column: 1,
    endLine: 8,
    endColumn: 3,
  });
  assert.equal(examples[0]?.expected, "one");
  assert.equal(examples[1]?.expected, null);
});

test("a nested fence in a list item is an example too", async () => {
  const tree = await parseMarkdown("- item\n\n  ```ts test\n  a\n  ```\n");
  const examples = examplesIn(tree);
  assert.equal(examples.length, 1);
  assert.equal(examples[0]?.code, "a");
  assert.equal(examples[0]?.pos.line, 3);
});
