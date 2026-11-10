import assert from "node:assert/strict";
import { test } from "node:test";
import type { Nodes } from "mdast";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/** Parse a page and render it, the way the Markdown stage does. */
async function htmlOf(body: string, bodyLine = 1): Promise<string> {
  const tree = await parseMarkdown(body, bodyLine);
  return (await markdownToHtml(tree, "page.md")).html;
}

/** Opening tags of every element the pattern matches. */
function tags(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

/** One attribute's value on an opening tag, or `undefined` when the attribute is absent. */
function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Whether an opening tag has an attribute, including a valueless boolean one. */
function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?=[\\s>=])`).test(tag);
}

function buttons(html: string): string[] {
  return tags(html, /<button\b[^>]*>/g);
}

function panels(html: string): string[] {
  return tags(html, /<div\b[^>]*\brole="tabpanel"[^>]*>/g);
}

function buttonTexts(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1] ?? "");
}

test("tabs is discovered after the order-10 plugins and before the directive stage", async () => {
  const plugins = await loadMarkdownPlugins();
  const tabs = plugins.find((plugin) => plugin.name === "tabs");
  assert.ok(tabs, "the tabs plugin is discovered from the plugins folder");
  assert.equal(tabs.order, 14);
  for (const name of ["gfm", "code", "links", "slug"]) {
    assert.ok(
      plugins.findIndex((plugin) => plugin.name === name) < plugins.indexOf(tabs),
      `tabs runs after ${name}`,
    );
  }
  assert.ok(plugins.indexOf(tabs) < plugins.findIndex((plugin) => plugin.name === "directives"));
});

test("a tabs container renders a tablist and one panel per tab, wired by ARIA", async () => {
  const html = await htmlOf(
    [
      ":::::tabs",
      ':::tab{label="macOS"}',
      "Use Homebrew.",
      ":::",
      "",
      ':::tab{label="Linux"}',
      "Use the archive.",
      ":::",
      ":::::",
      "",
    ].join("\n"),
  );

  assert.match(html, /^<div class="tabs" data-tabs-group="tabs-1-1"/);
  assert.match(html, /<div role="tablist">/);

  const list = buttons(html);
  const bodies = panels(html);
  assert.equal(list.length, 2);
  assert.equal(bodies.length, 2);
  assert.deepEqual(buttonTexts(html), ["macOS", "Linux"]);

  assert.equal(attr(list[0]!, "id"), "tabs-1-1-macos-1");
  assert.equal(attr(list[1]!, "id"), "tabs-1-1-linux-2");
  assert.equal(attr(list[0]!, "aria-controls"), attr(bodies[0]!, "id"));
  assert.equal(attr(list[1]!, "aria-controls"), attr(bodies[1]!, "id"));
  assert.equal(attr(bodies[0]!, "aria-labelledby"), attr(list[0]!, "id"));
  assert.equal(attr(bodies[1]!, "aria-labelledby"), attr(list[1]!, "id"));

  assert.match(html, /Use Homebrew\./);
  assert.match(html, /Use the archive\./);
});

test("only the first tab is selected and only the first panel is shown in the static HTML", async () => {
  const html = await htmlOf(":::::tabs\n:::tab{label=A}\none\n:::\n\n:::tab{label=B}\ntwo\n:::\n:::::\n");
  const list = buttons(html);
  const bodies = panels(html);

  assert.equal(attr(list[0]!, "aria-selected"), "true");
  assert.equal(attr(list[0]!, "tabindex"), "0");
  assert.equal(hasAttr(list[1]!, "aria-selected"), false);
  assert.equal(attr(list[1]!, "tabindex"), "-1");

  assert.equal(hasAttr(bodies[0]!, "hidden"), false);
  assert.equal(hasAttr(bodies[1]!, "hidden"), true);
});

test("label attributes, container labels, and leaf labels all name their tab", async () => {
  const html = await htmlOf(
    [
      ":::::tabs",
      ':::tab{label="macOS"}',
      "attribute label",
      ":::",
      "",
      ":::tab[Linux]",
      "container label",
      ":::",
      "",
      "::tab[Windows]",
      ":::::",
      "",
    ].join("\n"),
  );
  assert.deepEqual(buttonTexts(html), ["macOS", "Linux", "Windows"]);
  assert.match(html, /container label/);
  assert.equal(panels(html).length, 3);
});

test("a tab without any label is numbered by its position", async () => {
  const html = await htmlOf(":::::tabs\n:::tab\none\n:::\n\n:::tab{label=\"\"}\ntwo\n:::\n:::::\n");
  assert.deepEqual(buttonTexts(html), ["1", "2"]);
});

test("tab bodies render Markdown, not text", async () => {
  const html = await htmlOf(
    [":::::tabs", ':::tab{label="Code"}', "**bold**", "", "```ts", "const x = 1;", "```", ":::", ":::::", ""].join(
      "\n",
    ),
  );
  const [panel] = panels(html);
  assert.ok(panel);
  const body = html.slice(html.indexOf(panel));
  assert.match(body, /<strong>bold<\/strong>/);
  assert.match(body, /<pre\b[^>]*><code class="language-ts">/);
});

test("each group gets its own key and ids: the group attribute else the source span", async () => {
  const html = await htmlOf(
    [
      ':::::tabs{group="install"}',
      ':::tab{label="npm"}',
      "npm install",
      ":::",
      "",
      ':::tab{label="Go"}',
      "go install",
      ":::",
      ":::::",
      "",
      ":::::tabs",
      ':::tab{label="npm"}',
      "pnpm install",
      ":::",
      ":::::",
      "",
    ].join("\n"),
  );

  const groups = tags(html, /<div class="tabs" data-tabs-group="[^"]*"[^>]*>/g);
  assert.equal(groups.length, 2);
  assert.equal(attr(groups[0]!, "data-tabs-group"), "install");
  assert.match(attr(groups[1]!, "data-tabs-group") ?? "", /^tabs-\d+-\d+$/);

  const list = buttons(html);
  assert.equal(attr(list[0]!, "id"), "install-npm-1");
  assert.equal(attr(list[0]!, "aria-controls"), "install-npm-1-panel");
  assert.equal(attr(list[1]!, "id"), "install-go-2");
  assert.notEqual(attr(list[2]!, "id"), attr(list[0]!, "id"), "same label in another group keeps a distinct id");
});

test("the group key and ids are deterministic across parses", async () => {
  const source = ":::::tabs\n:::tab{label=A}\none\n:::\n:::::\n";
  assert.equal(await htmlOf(source), await htmlOf(source));
});

test("the outer element and the tab bodies keep their source spans", async () => {
  const html = await htmlOf("One\n\n:::::tabs\n:::tab{label=\"A\"}\nBody.\n:::\n:::::\n", 5);
  const [outer] = tags(html, /<div class="tabs"[^>]*>/g);
  assert.ok(outer);
  assert.equal(attr(outer, "data-tabs-group"), "tabs-3-1");
  assert.match(attr(outer, "data-src") ?? "", /^page\.md:7:1-\d+:\d+$/);
  assert.match(html, /<p data-src="page\.md:9:1-9:5">Body\.<\/p>/);
});

test("labels are escaped, never emitted as markup", async () => {
  const html = await htmlOf(':::::tabs\n:::tab{label="<script>alert(1)</script>"}\nBody\n:::\n:::::\n');
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&#x3C;script>alert\(1\)&#x3C;\/script>/);
});

test("a tabs group with no tab children is left as an ordinary directive", async () => {
  const html = await htmlOf(":::tabs\nJust text.\n:::\n");
  assert.equal(html.includes('class="tabs"'), false);
  assert.match(html, /Just text\./);
});

test("a tabs group with a child that is not a tab is left untouched", async () => {
  const html = await htmlOf(":::::tabs\n:::tab{label=\"A\"}\none\n:::\n\nNot a tab.\n:::::\n");
  assert.equal(html.includes('class="tabs"'), false);
  assert.match(html, /one/);
  assert.match(html, /Not a tab\./);
});

test("a tab outside a tabs group is left as an ordinary directive", async () => {
  const html = await htmlOf("::tab[macOS]\n");
  assert.equal(html.includes('class="tabs"'), false);
  assert.match(html, /macOS/);
});

test("non-tabs directives and plain content are untouched", async () => {
  const plain = await parseMarkdown("# Title\n\nA paragraph.\n\n> quote\n\n```ts\nconst x = 1;\n```\n");
  assert.deepEqual(
    plain.children.map((node: Nodes) => node.type),
    ["heading", "paragraph", "blockquote", "code"],
  );

  const html = await htmlOf(":::callout{type=tip}\nCareful.\n:::\n");
  assert.equal(html.includes('class="tabs"'), false);
  assert.match(html, /<sl-component name="callout"/);
});
