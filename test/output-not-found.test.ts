import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { notFound } from "../src/outputs/not-found.ts";

const pos = { file: "404.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    base: "",
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
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

function page(url: string, kind: Page["kind"] = "doc"): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind,
  };
}

/** The document the render host answers with, naming the page it rendered. */
function renderedDocument(p: Page): string {
  return `<!DOCTYPE html>\n<html lang="${p.lang}"><title>${p.url}</title></html>`;
}

/** A render host that records every page it renders, so a test can check whether the output rendered one at all. */
function collecting(): { ctx: OutputContext; rendered: Page[] } {
  const rendered: Page[] = [];
  const ctx: OutputContext = {
    renderPage: (p) => {
      rendered.push(p);
      return Promise.resolve(renderedDocument(p));
    },
    report: () => {},
  };
  return { ctx, rendered };
}

/** The only file the output writes, as text. */
function only(files: readonly OutputFile[]): string {
  assert.equal(files.length, 1, "the output writes one file");
  assert.equal(files[0]?.path, "404.html");
  return String(files[0]?.contents);
}

test("the output is named not-found and writes a plain 404.html when the site has no 404 page", async () => {
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([page("/guide/install/")]), ctx);

  assert.equal(notFound.name, "not-found");
  assert.deepEqual(rendered, [], "there is no page to render");
  const html = only(files);
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en" dir="ltr">/);
  assert.match(html, /<title>Page not found<\/title>/);
  assert.match(html, /<h1>Page not found<\/h1>/);
  assert.match(html, /<a href="\/">Go to the home page<\/a>/, "the link home is root-relative");
  assert.doesNotMatch(html, /<script|<link/, "the plain page needs no asset");
});

test("the plain page follows the site language, direction, and base", async () => {
  const { ctx, rendered } = collecting();
  const html = only(await notFound.run(site([], { base: "/docs", lang: "fa", dir: "rtl" }), ctx));

  assert.deepEqual(rendered, []);
  assert.match(html, /<html lang="fa" dir="rtl">/);
  assert.match(html, /<a href="\/docs\/">Go to the home page<\/a>/, "the link carries base, so it works at any depth");
});

test("a page at 404/ is rendered through its layout and written at the root", async () => {
  const missing = page("/404/");
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([page("/guide/install/"), missing]), ctx);

  assert.deepEqual(rendered, [missing], "the site's own 404 page is the one rendered");
  assert.equal(only(files), renderedDocument(missing));
});

test("a page at 404 without a trailing slash is treated the same way", async () => {
  const missing = page("/404");
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([missing]), ctx);

  assert.deepEqual(rendered, [missing]);
  assert.equal(only(files), renderedDocument(missing));
});

test("a page at 404.html is left to the HTML output, which writes the same file", async () => {
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([page("/404.html")]), ctx);

  assert.deepEqual(files, [], "writing the same path twice would be a duplicate-path error");
  assert.deepEqual(rendered, []);
});

test("when the HTML output is off, a page at 404.html is written here instead", async () => {
  const missing = page("/404.html");
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([missing], { outputs: { html: false } }), ctx);

  assert.deepEqual(rendered, [missing]);
  assert.equal(only(files), renderedDocument(missing));
});

test("the base path is stripped along whole segments when the model names the 404 page", async () => {
  const missing = page("/docs/404/");
  const { ctx, rendered } = collecting();
  const files = await notFound.run(site([missing], { base: "/docs" }), ctx);

  assert.deepEqual(rendered, [missing]);
  assert.equal(only(files), renderedDocument(missing));

  const lookalike = collecting();
  const plain = only(await notFound.run(site([page("/docs-2/404/")], { base: "/docs" }), lookalike.ctx));
  assert.deepEqual(lookalike.rendered, [], "a folder whose name only starts with base is not the site root");
  assert.match(plain, /<a href="\/docs\/">/);
});

test("an app page at 404.html does not stand in for the document", async () => {
  const { ctx, rendered } = collecting();
  const html = only(await notFound.run(site([page("/404.html", "app")]), ctx));

  assert.deepEqual(rendered, [], "app pages are copied, not rendered");
  assert.match(html, /<h1>Page not found<\/h1>/);
});
