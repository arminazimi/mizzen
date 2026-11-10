import assert from "node:assert/strict";
import { h } from "preact";
import { test } from "node:test";
import type { Head, Layout, Page, Site } from "../src/contracts/index.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";
import { renderPage } from "../src/render/render.ts";
import type { ThemeComponent } from "../src/render/render.ts";

const pos = { file: "docs/guide/install.md", line: 3, column: 1, endLine: 9, endColumn: 1 };

const site: Site = {
  config: {
    title: "Example",
    base: "/example",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  },
  pages: [],
  nav: {},
  data: {},
};

const head: Head = { title: "Install", meta: [], links: [], jsonLd: [] };

function page(html: string, overrides: Partial<Page> = {}): Page {
  return {
    url: "/example/guide/install/",
    source: pos,
    frontMatter: { title: "Install" },
    title: "Install",
    lang: "en",
    dir: "ltr",
    headings: [],
    html,
    markdown: "# Install\n",
    kind: "doc",
    ...overrides,
  };
}

const layout: Layout = ({ page: p, islands }) =>
  h("html", null, h("head", null, h("title", null, p.title)), h("body", null, h("main", { dangerouslySetInnerHTML: { __html: p.html } }), ...islands.map((i) => h("script", { type: "module", src: i.src }))));

const callout: ThemeComponent = {
  component: ({ props, html }) => h("aside", { class: `callout callout-${String(props.type ?? "note")}`, dangerouslySetInnerHTML: { __html: html } }),
  css: "components/callout/style.css",
  island: { name: "callout", src: "/example/assets/callout.js" },
};

const badge: ThemeComponent = {
  component: ({ props }) => h("span", { class: "badge" }, String(props.label ?? "")),
  css: "components/badge/style.css",
};

test("a layout and a component render; data-src stays on the component root", () => {
  const body =
    '<p data-src="docs/guide/install.md:3">Before</p>' +
    '<sl-component name="callout" data-props="{&quot;type&quot;:&quot;warning&quot;}" data-src="docs/guide/install.md:5"><p>Watch out</p></sl-component>' +
    '<p data-src="docs/guide/install.md:9">After</p>';
  const result = renderPage({
    site,
    page: page(body),
    layout,
    components: { callout },
    trail: [],
    pager: {},
    head,
  });
  assert.match(result.html, /^<!DOCTYPE html>\n<html lang="en" dir="ltr">/);
  assert.match(result.html, /<aside class="callout callout-warning" data-src="docs\/guide\/install\.md:5"><p>Watch out<\/p><\/aside>/);
  assert.match(result.html, /<p data-src="docs\/guide\/install\.md:3">Before<\/p>/);
  assert.match(result.html, /<script type="module" src="\/example\/assets\/callout\.js"><\/script>/);
  assert.deepEqual(result.islands, [{ name: "callout", src: "/example/assets/callout.js" }]);
  assert.deepEqual(result.css, ["components/callout/style.css"]);
  assert.equal(result.diagnostics.length, 0);
});

test("a directive's props survive the Markdown stage", async () => {
  const tree = await parseMarkdown(':::callout{type=warning}\nWatch out.\n:::\n\n::badge{label="New"}\n');
  const { html } = await markdownToHtml(tree, "a.md");
  const result = renderPage({
    site,
    page: page(html),
    layout,
    components: { badge, callout },
    trail: [],
    pager: {},
    head,
  });
  assert.equal(result.diagnostics.length, 0);
  assert.match(result.html, /<aside class="callout callout-warning"/);
  assert.match(result.html, /<span class="badge"[^>]*>New<\/span>/);
});

test("nested components resolve inside-out and collect each island and CSS once, sorted by name", () => {
  const components: Record<string, ThemeComponent> = { badge, callout };
  // Force a second name so sort order is visible: badge before callout.
  const body =
    '<sl-component name="callout" data-src="a.md:1">' +
    '<sl-component name="badge" data-props="{&quot;label&quot;:&quot;new&quot;}" data-src="a.md:2"></sl-component>' +
    " body" +
    "</sl-component>" +
    '<sl-component name="badge" data-props="{&quot;label&quot;:&quot;again&quot;}" data-src="a.md:3"></sl-component>';
  const result = renderPage({
    site,
    page: page(body),
    layout,
    components,
    trail: [],
    pager: {},
    head,
  });
  assert.match(result.html, /<aside class="callout callout-note" data-src="a\.md:1"><span class="badge" data-src="a\.md:2">new<\/span> body<\/aside>/);
  assert.match(result.html, /<span class="badge" data-src="a\.md:3">again<\/span>/);
  assert.deepEqual(
    result.islands.map((i) => i.name),
    ["callout"],
  );
  assert.deepEqual(result.css, ["components/badge/style.css", "components/callout/style.css"]);
});

test("html lang and dir come from the page, including RTL", () => {
  const result = renderPage({
    site,
    page: page("<p>سلام</p>", { lang: "fa", dir: "rtl", title: "نصب" }),
    layout: ({ page: p }) => h("main", null, p.title),
    components: {},
    trail: [],
    pager: {},
    head,
  });
  assert.equal(result.html, '<!DOCTYPE html>\n<html lang="fa" dir="rtl">\n<main>نصب</main>\n</html>');
});

test("an unknown component warns and passes its children through", () => {
  const body = '<sl-component name="missing" data-src="a.md:4"><em>x</em></sl-component>';
  const result = renderPage({
    site,
    page: page(body),
    layout,
    components: {},
    trail: [],
    pager: {},
    head,
  });
  assert.match(result.html, /<em>x<\/em>/);
  assert.doesNotMatch(result.html, /sl-component/);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "render.unknown-component");
  assert.equal(result.diagnostics[0]?.pos?.file, "a.md");
  assert.equal(result.diagnostics[0]?.pos?.line, 4);
});

test("a page with no components collects no islands or CSS", () => {
  const result = renderPage({
    site,
    page: page('<p data-src="a.md:1">plain</p>'),
    layout,
    components: { callout },
    trail: [],
    pager: {},
    head,
  });
  assert.deepEqual(result.islands, []);
  assert.deepEqual(result.css, []);
  assert.match(result.html, /<p data-src="a\.md:1">plain<\/p>/);
});
