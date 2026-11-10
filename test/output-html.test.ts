import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page, Site } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { html } from "../src/outputs/html.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function site(base: string, pages: readonly Page[]): Site {
  return {
    config: {
      title: "Example",
      base,
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
    pages,
    nav: {},
    data: {},
  };
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

/** A render host that answers with a document naming the page, so each file's contents name its page. */
const ctx: OutputContext = {
  renderPage: (p) => Promise.resolve(`<!DOCTYPE html>\n<html lang="${p.lang}"><title>${p.url}</title></html>`),
  report: () => {},
};

function byPath(files: readonly OutputFile[]): Map<string, OutputFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** The output path the contract gives a page URL, restated from the contract instead of imported. */
function expectedPath(url: string): string {
  const last = url.slice(url.lastIndexOf("/") + 1);
  const path = last.includes(".") ? url : `${url.endsWith("/") ? url : `${url}/`}index.html`;
  return path.replace(/^\//, "");
}

test("every doc page of fixtures/docs-site is written to its own index.html and app pages are skipped", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const files = byPath(await html.run(model, ctx));

  const docs = model.pages.filter((p) => p.kind === "doc");
  assert.ok(docs.length > 0, "the fixture has doc pages");
  assert.ok(docs.some((p) => p.url === "/quickstart/"), "the fixture has a doc at /quickstart/");
  assert.ok(model.pages.some((p) => p.kind === "app" && p.url === "/dashboard/"), "the fixture has an app page");

  for (const p of docs) {
    const file = files.get(expectedPath(p.url));
    assert.ok(file, `missing index.html for ${p.url}`);
    assert.equal(file.contents, await ctx.renderPage(p), `${p.url} renders that page`);
  }
  assert.equal(files.size, docs.length, "nothing beyond the doc pages");
  assert.ok(![...files.keys()].some((f) => f.startsWith("dashboard/")), "the app page writes nothing");
  assert.ok(files.has("404.html"), "the 404 page's permalink names its file exactly");
});

test("the base path is stripped from the file path and the site root becomes index.html", async () => {
  const model = site("/evergreen", [
    page("/evergreen/", "doc"),
    page("/evergreen/guide/install/", "doc"),
    page("/evergreen/dashboard/", "app"),
    page("/evergreen/logo.svg", "asset"),
  ]);
  const files = byPath(await html.run(model, ctx));
  assert.deepEqual([...files.keys()], ["guide/install/index.html", "index.html"]);
  assert.equal(files.get("index.html")?.contents, await ctx.renderPage(page("/evergreen/", "doc")));
});

test("the base strips along whole path segments, so a longer name keeps its folder", async () => {
  const model = site("/evergreen", [page("/evergreen-2/guide/", "doc")]);
  const files = byPath(await html.run(model, ctx));
  assert.deepEqual([...files.keys()], ["evergreen-2/guide/index.html"]);
});

test("a page url without a trailing slash still writes an index.html inside it", async () => {
  const model = site("", [page("/x", "doc")]);
  const files = byPath(await html.run(model, ctx));
  assert.deepEqual([...files.keys()], ["x/index.html"]);
});

test("a url that names a file is written exactly as its permalink says", async () => {
  const model = site("", [page("/404.html", "doc")]);
  const files = byPath(await html.run(model, ctx));
  assert.deepEqual([...files.keys()], ["404.html"]);
});

test("the files come back sorted by path, whatever order the model listed the pages in", async () => {
  const model = site("", [page("/b/", "doc"), page("/a/c/", "doc"), page("/a/", "doc")]);
  const files = await html.run(model, ctx);
  assert.deepEqual(files.map((f) => f.path), ["a/c/index.html", "a/index.html", "b/index.html"]);
});
