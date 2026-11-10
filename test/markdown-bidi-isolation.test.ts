import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/** Parse and render one page the way the build does. */
async function render(markdown: string): Promise<string> {
  const tree = await parseMarkdown(markdown, 1);
  const { html } = await markdownToHtml(tree, "fa/install.md");
  return html;
}

test("bidi-isolation is discovered from the plugins folder", async () => {
  const unit = (await loadMarkdownPlugins()).find((plugin) => plugin.name === "bidi-isolation");
  assert.ok(unit, "the bidi-isolation plugin is discovered from the plugins folder");
  assert.equal(unit.order, 40, "it runs after every plugin that rewrites inline content");
});

test("a Persian paragraph isolates its inline code and its numbers", async () => {
  const html = await render("نسخه `1.2.0` را با 3 مرحله نصب کنید.");
  assert.equal(
    html,
    '<p data-src="fa/install.md:1:1-1:36">نسخه <span dir="ltr"><code>1.2.0</code></span> را با <span dir="ltr">3</span> مرحله نصب کنید.</p>',
  );
});

test("a left-to-right page renders exactly as it would without the plugin", async () => {
  const html = await render("Run `npm ci` in 3 steps.");
  assert.equal(html, '<p data-src="fa/install.md:1:1-1:24">Run <code>npm ci</code> in 3 steps.</p>');
});

test("a code block in a Persian page keeps its text and gets no isolate", async () => {
  const html = await render("نسخه `npm` را نصب کنید.\n\n```bash\nnpm ci --version 3\n```\n");
  assert.equal(
    html,
    '<p data-src="fa/install.md:1:1-1:23">نسخه <span dir="ltr"><code>npm</code></span> را نصب کنید.</p>\n' +
      '<pre data-src="fa/install.md:3:1-5:3"><code class="language-bash">npm ci --version 3\n</code></pre>',
  );
});

test("a number inside a Latin phrase in an RTL paragraph stays bare", async () => {
  const html = await render("نسخه `npm` را با run 3 times نصب کنید.");
  assert.match(html, /با run 3 times/);
  assert.doesNotMatch(html, /<span dir="ltr">3<\/span>/);
});

test("list items and table cells are isolated, including a numeric cell in a Persian table", async () => {
  const html = await render(
    "- نسخه 2.0 را اجرا کنید.\n- `npm` را اجرا کنید.\n\n| نام | نسخه |\n| - | - |\n| بسته | 1.2 |\n",
  );
  assert.match(html, /<li>نسخه <span dir="ltr">2\.0<\/span> را اجرا کنید\.<\/li>/);
  assert.match(html, /<li><span dir="ltr"><code>npm<\/code><\/span> را اجرا کنید\.<\/li>/);
  assert.match(html, /<td><span dir="ltr">1\.2<\/span><\/td>/);
});

test("a block that already sets dir is left alone, so nothing is wrapped twice", async () => {
  const html = await render('<span dir="ltr">123</span> نسخه ۴ را نصب کنید.');
  assert.equal(
    html,
    '<p data-src="fa/install.md:1:1-1:46"><span dir="ltr">123</span> نسخه ۴ را نصب کنید.</p>',
  );
});

test("the same page renders the same HTML twice", async () => {
  const markdown = "نسخه `1.2.0` را با 3 مرحله نصب کنید.";
  assert.equal(await render(markdown), await render(markdown));
});
