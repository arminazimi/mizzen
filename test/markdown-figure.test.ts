import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { MISSING_ALT, figureDiagnostics } from "../src/markdown/plugins/figure.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/** Parse a page and render it the way the Markdown stage does. */
async function htmlOf(body: string, bodyLine = 1): Promise<string> {
  const tree = await parseMarkdown(body, bodyLine);
  return (await markdownToHtml(tree, "page.md")).html;
}

test("figure is discovered after the directive unit and before the render step", async () => {
  const plugins = await loadMarkdownPlugins();
  const figure = plugins.find((plugin) => plugin.name === "figure");
  assert.ok(figure, "the figure plugin is discovered from the plugins folder");
  assert.equal(figure.order, 21);
  for (const name of ["code", "tabs", "admonition", "directives"]) {
    assert.ok(
      plugins.findIndex((plugin) => plugin.name === name) < plugins.indexOf(figure),
      `figure runs after ${name}`,
    );
  }
});

test("an image directive renders a semantic figure with its caption, id, and source span", async () => {
  const html = await htmlOf(
    [':::figure{#pipeline caption="The eight build stages"}', "![The pipeline](/img/pipeline.svg)", ":::", ""].join("\n"),
  );

  assert.match(html, /^<figure\b[^>]*\bid="pipeline"/);
  assert.match(html, /<img src="\/img\/pipeline\.svg" alt="The pipeline">/, "the image is inside the figure, not a paragraph");
  assert.match(html, /<figcaption>The eight build stages<\/figcaption><\/figure>$/);
  assert.match(html, /\bdata-src="page\.md:1:1-3:3"/, "the figure keeps the directive's span");
});

test("a fenced code block becomes the figure's content", async () => {
  const html = await htmlOf(
    [':::figure{#stages caption="The pipeline, in order"}', "```ts", "const stages = 8;", "```", ":::", ""].join("\n"),
  );

  assert.match(html, /^<figure\b[^>]*\bid="stages"/);
  assert.match(html, /<pre\b[^>]*><code class="language-ts">const stages = 8;\n<\/code><\/pre>/);
  assert.match(html, /<\/pre><figcaption>The pipeline, in order<\/figcaption><\/figure>$/);
});

test("an image without alt text reports a diagnostic with the directive's line and no figure is rendered", async () => {
  const tree = await parseMarkdown("Intro\n\n:::figure{#broken}\n![](/img/blank.png)\n:::\n", 5);
  const diagnostics = figureDiagnostics(tree, "guide/page.md");

  assert.equal(diagnostics.length, 1);
  const [finding] = diagnostics;
  assert.ok(finding);
  assert.equal(finding.id, MISSING_ALT);
  assert.equal(finding.id, "figure.missing-alt");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.pos?.file, "guide/page.md");
  assert.equal(finding.pos?.line, 7, "the line where the directive opens, in the page's source file");

  const html = (await markdownToHtml(tree, "page.md")).html;
  assert.doesNotMatch(html, /<figure\b/, "a broken figure is never rendered");
  assert.doesNotMatch(html, /<figcaption\b/);
  assert.match(html, /<img src="\/img\/blank\.png" alt="">/, "the image is left as ordinary content");
});

test("a figure without a caption has no figcaption", async () => {
  const html = await htmlOf([":::figure{#only}", "![The logo](/logo.svg)", ":::", ""].join("\n"));

  assert.match(html, /^<figure\b[^>]*\bid="only"/);
  assert.match(html, /<img src="\/logo\.svg" alt="The logo">/);
  assert.doesNotMatch(html, /<figcaption\b/);
});

test("a directive label is the caption, and the caption attribute wins over it", async () => {
  const labelled = await htmlOf(":::figure[The pipeline]{#pipeline}\n![The pipeline](/img/pipeline.svg)\n:::\n");
  assert.match(labelled, /<figcaption>The pipeline<\/figcaption>/);

  const attributed = await htmlOf(
    ':::figure[The label]{#pipeline caption="The attribute"}\n![The pipeline](/img/pipeline.svg)\n:::\n',
  );
  assert.match(attributed, /<figcaption>The attribute<\/figcaption>/);
  assert.doesNotMatch(attributed, /The label/);
});

test("alt whitespace alone counts as missing", async () => {
  const tree = await parseMarkdown(":::figure\n![   ](/img/a.png)\n:::\n");
  assert.equal(figureDiagnostics(tree, "page.md").length, 1);
});

test("an ordinary Markdown image is not a figure and reports nothing", async () => {
  const tree = await parseMarkdown("![The pipeline](/img/pipeline.svg)\n");
  const html = (await markdownToHtml(tree, "page.md")).html;

  assert.doesNotMatch(html, /<figure\b/);
  assert.match(html, /^<p\b[^>]*><img src="\/img\/pipeline\.svg" alt="The pipeline"><\/p>$/);
  assert.deepEqual(figureDiagnostics(tree, "page.md"), []);
});

test("a body that is neither one image nor one code block stays content, without a figure", async () => {
  const html = await htmlOf([":::figure{#notes}", "Some prose, not a figure.", ":::", ""].join("\n"));

  assert.doesNotMatch(html, /<figure\b/);
  assert.match(html, /Some prose, not a figure\./);
});

test("the same source renders the same HTML on every run", async () => {
  const body = [':::figure{#pipeline caption="Stable"}', "![The pipeline](/img/pipeline.svg)", ":::", ""].join("\n");
  assert.equal(await htmlOf(body), await htmlOf(body));
});
