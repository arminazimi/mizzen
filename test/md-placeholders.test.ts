import assert from "node:assert/strict";
import { test } from "node:test";
import type { Code, InlineCode, Nodes, Root } from "mdast";
import type { Page } from "../src/contracts/index.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";
import { placeholdersIn, placeholdersOf, type Placeholder } from "../src/markdown/plugins/placeholders.ts";

function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function codesIn(tree: Root): Code[] {
  const found: Code[] = [];
  visit(tree, (node) => {
    if (node.type === "code") found.push(node);
  });
  return found;
}

function inlineCodesIn(tree: Root): InlineCode[] {
  const found: InlineCode[] = [];
  visit(tree, (node) => {
    if (node.type === "inlineCode") found.push(node);
  });
  return found;
}

/** The rendered `data-placeholders` value, with the HTML entities an attribute value carries. */
function placeholdersAttribute(html: string): string {
  const match = /\bdata-placeholders="([^"]*)"/.exec(html);
  assert.ok(match, "the code element carries data-placeholders");
  return (match[1] ?? "")
    .replace(/&#x22;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function page(markdown: string, line = 1): Page {
  return {
    url: "/guide/",
    source: { file: "guide/install.md", line, column: 1, endLine: line, endColumn: 1 },
    frontMatter: {},
    title: "Install",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

test("placeholders is discovered between code and directives", async () => {
  const names = (await loadMarkdownPlugins()).map((plugin) => plugin.name);
  const unit = (await loadMarkdownPlugins()).find((plugin) => plugin.name === "placeholders");
  assert.ok(unit, "the placeholders plugin is discovered from the plugins folder");
  assert.equal(unit?.order, 15);
  assert.ok(names.indexOf("placeholders") > names.indexOf("code"), "runs after code");
  assert.ok(names.indexOf("placeholders") < names.indexOf("directives"), "runs before directives");
});

test("an inline placeholder becomes a stable span inside the code element", async () => {
  const tree = await parseMarkdown("Set `{{api_key}}` first.\n");
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(
    html,
    /<code><span class="placeholder" data-var="api_key">\{\{api_key\}\}<\/span><\/code>/,
  );
  assert.equal(inlineCodesIn(tree)[0]?.value, "{{api_key}}", "the code text is kept for headings and search");
});

test("several placeholders in one code span keep their order and the text around them", async () => {
  const tree = await parseMarkdown("Run `curl {{host}}/{{path}}` now.\n");
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(
    html,
    /<code>curl <span class="placeholder" data-var="host">\{\{host\}\}<\/span>\/<span class="placeholder" data-var="path">\{\{path\}\}<\/span><\/code>/,
  );
});

test("spaces inside the braces are trimmed and the rendered placeholder is normalized", async () => {
  const tree = await parseMarkdown("Set `{{  api_key  }}` first.\n");
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /data-var="api_key">\{\{api_key\}\}<\/span>/);
  assert.deepEqual(placeholdersIn(tree, "Set `{{  api_key  }}` first.\n"), [
    { name: "api_key", kind: "inline-code", line: 1, column: 6, endLine: 1, endColumn: 20 },
  ]);
});

test("an escaped inline placeholder stays literal and loses only its backslash", async () => {
  const source = "Write `\\{{api_key}}` literally.\n";
  const tree = await parseMarkdown(source);
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /<code>\{\{api_key\}\}<\/code>/);
  assert.doesNotMatch(html, /<span class="placeholder"/);
  assert.equal(inlineCodesIn(tree)[0]?.value, "{{api_key}}");
  assert.deepEqual(placeholdersIn(tree, source), [], "the escaped placeholder is not a variable");
});

test("a fenced block keeps its text byte for byte and records its variables on the node", async () => {
  const body = "{{one}} {{two}}";
  const source = `\`\`\`sh\n${body}\n\`\`\`\n`;
  const tree = await parseMarkdown(source);
  const [code] = codesIn(tree);
  assert.ok(code);
  assert.equal(code.value, body, "the raw code is not rewritten");
  assert.equal(code.data?.hName, undefined, "the block is not turned into another element");
  const recorded = JSON.parse(String(code.data?.hProperties?.["data-placeholders"] ?? "null")) as Placeholder[];
  assert.deepEqual(recorded, [
    { name: "one", line: 2, column: 1, endLine: 2, endColumn: 7 },
    { name: "two", line: 2, column: 9, endLine: 2, endColumn: 15 },
  ]);

  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /<code[^>]*>/, "the code element is stable");
  assert.deepEqual(JSON.parse(placeholdersAttribute(html)), recorded);
  assert.match(html, /\{\{one\}\} \{\{two\}\}/, "the visible code text is unchanged");
  assert.doesNotMatch(html, /<span class="placeholder"/, "the theme wraps block placeholders, not the engine");
});

test("an escaped placeholder in a fenced block is not a variable and its text is untouched", async () => {
  const body = "\\{{x}}";
  const source = `\`\`\`\n${body}\n\`\`\`\n`;
  const tree = await parseMarkdown(source);
  const [code] = codesIn(tree);
  assert.equal(code?.value, body);
  assert.equal(code?.data?.hProperties?.["data-placeholders"], undefined);
  assert.deepEqual(placeholdersIn(tree, source), []);
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /\\\{\{x\}\}/);
});

test("names take letters, digits, underscore, dot, and dash; anything else is plain code", async () => {
  const tree = await parseMarkdown("Try `{{api-key.v2_1}}`, `{{}}`, `{{a b}}`, `{{a/b}}`.\n");
  assert.deepEqual(
    placeholdersIn(tree, "Try `{{api-key.v2_1}}`, `{{}}`, `{{a b}}`, `{{a/b}}`.\n").map((found) => found.name),
    ["api-key.v2_1"],
  );
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /data-var="api-key.v2_1"/);
  assert.match(html, /<code>\{\{\}\}<\/code>/);
  assert.match(html, /<code>\{\{a b\}\}<\/code>/);
  assert.match(html, /<code>\{\{a\/b\}\}<\/code>/);
});

test("plain text is untouched byte for byte", async () => {
  const source = "Prose may mention {{api_key}} without it being a variable.\n";
  const tree = await parseMarkdown(source);
  const paragraph = tree.children[0];
  assert.ok(paragraph && paragraph.type === "paragraph");
  const text = paragraph.children[0];
  assert.ok(text && text.type === "text");
  assert.equal(text.value, "Prose may mention {{api_key}} without it being a variable.");
  assert.deepEqual(placeholdersIn(tree, source), []);
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /Prose may mention \{\{api_key\}\} without it being a variable\./);
  assert.doesNotMatch(html, /placeholder/);
});

test("positions are exact for a fenced block and an inline span", async () => {
  const source = "Run `{{x}}` here.\n\n```sh\necho {{y}}\n```\n";
  const tree = await parseMarkdown(source);
  assert.deepEqual(placeholdersIn(tree, source), [
    { name: "x", kind: "inline-code", line: 1, column: 6, endLine: 1, endColumn: 10 },
    { name: "y", kind: "code", line: 4, column: 6, endLine: 4, endColumn: 10 },
  ]);
});

test("placeholdersOf reports the page span from the body line", async () => {
  const found = await placeholdersOf(page("```sh\necho {{project}}\n```\n", 10));
  assert.deepEqual(found, [
    { name: "project", kind: "code", line: 11, column: 6, endLine: 11, endColumn: 16 },
  ]);
});

test("the same page gives the same records and HTML every time", async () => {
  const source = "One `{{a}}` and `{{b}}`.\n\n```sh\necho {{c}}\n```\n";
  const first = await parseMarkdown(source);
  const second = await parseMarkdown(source);
  assert.deepEqual(placeholdersIn(first, source), placeholdersIn(second, source));
  assert.deepEqual(placeholdersIn(first, source), [
    { name: "a", kind: "inline-code", line: 1, column: 6, endLine: 1, endColumn: 10 },
    { name: "b", kind: "inline-code", line: 1, column: 18, endLine: 1, endColumn: 22 },
    { name: "c", kind: "code", line: 4, column: 6, endLine: 4, endColumn: 10 },
  ]);
  const one = await markdownToHtml(first, "guide/install.md");
  const two = await markdownToHtml(second, "guide/install.md");
  assert.equal(one.html, two.html);
});

test("the inline node keeps its type, position, and the block's data-src", async () => {
  const tree = await parseMarkdown("Set `{{api_key}}` first.\n");
  const [code] = inlineCodesIn(tree);
  assert.ok(code);
  assert.equal(code.type, "inlineCode");
  assert.deepEqual(
    { line: code.position?.start.line, column: code.position?.start.column },
    { line: 1, column: 5 },
  );
  assert.equal(code.data?.hName, "code");
  const { html } = await markdownToHtml(tree, "guide/install.md");
  assert.match(html, /^<p data-src="guide\/install\.md:1:1-1:24">/);
});
