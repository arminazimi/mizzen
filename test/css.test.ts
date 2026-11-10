import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { h } from "preact";
import type { Head, Layout, Page, Site } from "../src/contracts/index.ts";
import { createCssBundler } from "../src/render/css.ts";
import { renderPage } from "../src/render/render.ts";
import type { ThemeComponent } from "../src/render/render.ts";

const CODE_CSS = ".code-block { background: rebeccapurple; }";
const CALLOUT_CSS = ".callout {\n  margin-inline-start: 1rem;\n  padding-inline: 0.5rem;\n}\n";
const BASE_CSS = "body {\n  margin: 0;\n}\n";

/** A temporary theme folder; each call gets its own, removed by the caller. */
function theme(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "css-theme-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

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

const head: Head = { title: "Page", meta: [], links: [], jsonLd: [] };

const pos = { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function page(html: string): Page {
  return {
    url: "/example/guide/",
    source: pos,
    frontMatter: { title: "Guide" },
    title: "Guide",
    lang: "en",
    dir: "ltr",
    headings: [],
    html,
    markdown: "# Guide\n",
    kind: "doc",
  };
}

const layout: Layout = ({ page: p }) => h("main", { dangerouslySetInnerHTML: { __html: p.html } });

const callout: ThemeComponent = {
  component: ({ html }) => h("aside", { class: "callout", dangerouslySetInnerHTML: { __html: html } }),
  css: "components/callout/style.css",
};

const code: ThemeComponent = {
  component: ({ html }) => h("pre", { class: "code-block", dangerouslySetInnerHTML: { __html: html } }),
  css: "components/code/style.css",
};

/** Renders a page the way the pipeline will, and returns the CSS identifiers it reports. */
function usedCss(html: string): string[] {
  return [...renderPage({ site, page: page(html), layout, components: { callout, code }, trail: [], pager: {}, head }).css];
}

test("a page with no code blocks loads no code CSS", async () => {
  const root = theme({
    "styles/base.css": BASE_CSS,
    "components/callout/style.css": CALLOUT_CSS,
    "components/code/style.css": CODE_CSS,
  });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: ["styles/base.css"] });
    const noCode = await bundler.page(usedCss('<sl-component name="callout" data-src="guide.md:1"><p>Hi</p></sl-component>'));
    assert.ok(noCode.page, "the callout's CSS is bundled");
    assert.match(noCode.page.css, /\.callout/);
    assert.doesNotMatch(noCode.page.css, /code-block/);
    assert.doesNotMatch(noCode.base.css, /code-block/);

    const withCode = await bundler.page(usedCss('<sl-component name="code" data-src="guide.md:3"><p>x</p></sl-component>'));
    assert.match(withCode.page?.css ?? "", /code-block/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("base and page bundles are minified, keep logical properties, and are named by their hash", async () => {
  const root = theme({
    "styles/base.css": BASE_CSS,
    "components/callout/style.css": CALLOUT_CSS,
  });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: ["styles/base.css"] });
    const out = await bundler.page(["components/callout/style.css"]);
    assert.equal(out.base.css, "body{margin:0}");
    assert.match(out.page?.css ?? "", /margin-inline-start:1rem/);
    assert.doesNotMatch(out.page?.css ?? "", /\n/);
    assert.equal(out.base.path, `assets/theme/base-${out.base.hash}.css`);
    assert.equal(out.page?.path, `assets/theme/page-${out.page?.hash}.css`);
    assert.match(out.base.hash, /^[0-9a-f]{16}$/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the same units in any order give the same cached bundle, and the base is shared", async () => {
  const root = theme({
    "styles/base.css": BASE_CSS,
    "components/callout/style.css": CALLOUT_CSS,
    "components/code/style.css": CODE_CSS,
  });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: ["styles/base.css"] });
    const first = await bundler.page(["components/code/style.css", "components/callout/style.css"]);
    const second = await bundler.page(["components/callout/style.css", "components/code/style.css"]);
    assert.equal(first.page, second.page, "the same bundle object is served from the cache");
    assert.equal(first.base, second.base);
    assert.equal(first.page?.path, second.page?.path);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a page that used no unit CSS gets no page bundle", async () => {
  const root = theme({ "styles/base.css": BASE_CSS });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: ["styles/base.css"] });
    const out = await bundler.page([]);
    assert.equal(out.page, undefined);
    assert.equal(out.base.css, "body{margin:0}");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a changed stylesheet makes a new bundle with a new name", async () => {
  const root = theme({ "components/callout/style.css": CALLOUT_CSS });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: [] });
    const before = await bundler.page(["components/callout/style.css"]);
    writeFileSync(join(root, "components/callout/style.css"), ".callout { color: red; }\n");
    const after = await bundler.page(["components/callout/style.css"]);
    assert.notEqual(before.page?.hash, after.page?.hash);
    assert.notEqual(before.page?.path, after.page?.path);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a listed stylesheet that is missing fails the bundle", async () => {
  const root = theme({ "styles/base.css": BASE_CSS });
  try {
    const bundler = createCssBundler({ themeRoot: root, base: ["styles/base.css"] });
    await assert.rejects(bundler.page(["components/gone/style.css"]), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
