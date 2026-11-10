import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { twinLink, twinUrl, twins } from "../src/outputs/twins.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Mizzen",
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

function page(url: string, kind: Page["kind"] = "doc", markdown = ""): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The twins output reads no render host and reports nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.resolve(""),
  report: () => {},
};

function byPath(files: readonly OutputFile[]): Map<string, OutputFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** The twin path the contract gives a page URL, restated from the contract instead of imported. */
function expectedPath(url: string, base = ""): string {
  const last = url.slice(url.lastIndexOf("/") + 1);
  const path = /\.html?$/i.test(last)
    ? `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".md")}`
    : `${url.endsWith("/") ? url : `${url}/`}index.md`;
  const under = base !== "" && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || "/" : path;
  return under.replace(/^\//, "");
}

test("every doc page of fixtures/docs-site gets its twin next to its HTML, carrying the page's Markdown", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const files = byPath(await twins.run(model, ctx));

  const docs = model.pages.filter((p) => p.kind === "doc" && twinUrl(p.url) !== undefined);
  assert.ok(docs.length > 0, "the fixture has doc pages");
  assert.ok(docs.some((p) => p.url === "/quickstart/"), "the fixture has a doc at /quickstart/");
  assert.ok(model.pages.some((p) => p.kind === "app" && p.url === "/dashboard/"), "the fixture has an app page");

  for (const p of docs) {
    const file = files.get(expectedPath(p.url));
    assert.ok(file, `missing index.md for ${p.url}`);
    assert.equal(file.contents, p.markdown, `${p.url} writes its Markdown body`);
  }
  assert.equal(files.size, docs.length, "nothing beyond the doc pages");
  assert.ok(files.has("install/index.md"), "a pretty URL twins inside its folder");
  assert.ok(files.has("404.md"), "a URL that names an HTML file becomes its .md name");
  assert.ok(![...files.keys()].some((f) => f.startsWith("dashboard/")), "the app page writes nothing");
});

test("the base path is stripped from the file path, and a URL naming a non-HTML file has no twin", async () => {
  const model = site(
    [
      page("/evergreen/", "doc", "# Home\n"),
      page("/evergreen/guide/install/", "doc", "# Install\n"),
      page("/evergreen/guide/old.html", "doc", "# Old\n"),
      page("/evergreen/404.html", "doc", "# Missing\n"),
      page("/evergreen/dashboard/", "app"),
      page("/evergreen/feed.xml", "doc", "# Feed\n"),
      page("/evergreen/logo.svg", "asset"),
    ],
    { base: "/evergreen" },
  );
  const files = await twins.run(model, ctx);
  assert.deepEqual(
    files.map((f) => f.path),
    ["404.md", "guide/install/index.md", "guide/old.md", "index.md"],
  );
  assert.equal(files[0]?.contents, "# Missing\n");
});

test("the twin sits at the page URL with a trailing index.md, whatever form the URL has", () => {
  assert.equal(twinUrl("/guide/install/"), "/guide/install/index.md");
  assert.equal(twinUrl("/guide/install"), "/guide/install/index.md");
  assert.equal(twinUrl("/"), "/index.md");
  assert.equal(twinUrl("/404.html"), "/404.md");
  assert.equal(twinUrl("/old.htm"), "/old.md");
  assert.equal(twinUrl("/feed.xml"), undefined);
  assert.equal(twinUrl("/logo.svg"), undefined);
});

test("a page's head can advertise its twin with rel=alternate and type=text/markdown", () => {
  const model = site([page("/evergreen/guide/install/")], { url: "https://example.com", base: "/evergreen" });
  const p = model.pages[0]!;
  const head = headMeta(model, p, []);
  const link = twinLink(p);
  assert.deepEqual(link, { rel: "alternate", href: "/evergreen/guide/install/index.md", attrs: { type: "text/markdown" } });
  assert.deepEqual([...head.links, link], [{ rel: "canonical", href: "https://example.com/evergreen/guide/install/" }, link]);
});

test("app pages, assets, and doc pages without a twin are advertised with no link", () => {
  assert.equal(twinLink(page("/dashboard/", "app")), undefined);
  assert.equal(twinLink(page("/logo.svg", "asset")), undefined);
  assert.equal(twinLink(page("/feed.xml", "doc")), undefined);
});

test("a twin is the page's Markdown exactly, with no title or URL header, and the same model gives the same bytes", async () => {
  const model = site([page("/guide/install/", "doc", "# Install\n\nRun `beacon --version`.\n")]);
  const first = await twins.run(model, ctx);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.path, "guide/install/index.md");
  assert.equal(first[0]?.contents, "# Install\n\nRun `beacon --version`.\n");
  assert.deepEqual(await twins.run(model, ctx), first);
});
