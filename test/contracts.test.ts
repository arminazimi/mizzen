import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Chrome, CodeConfig, Component, Diagnostic, Head, Island, Layout, NavTree, Output, Page, Pager, Plugin, Site, SiteConfig, SourcePos, Trail,
} from "../src/contracts/index.ts";

// These values only have to type-check (`npm run typecheck`); the runtime assertions keep the test from being empty.

const pos: SourcePos = { file: "docs/guide/install.md", line: 3, column: 1, endLine: 9, endColumn: 1 };

const config: SiteConfig = {
  title: "Example",
  base: "/example",
  lang: "en",
  dir: "ltr",
  languages: [{ code: "fa", name: "فارسی", prefix: "/fa" }],
  source: ".",
  include: [".well-known"],
  exclude: [],
  navigation: "_data/navigation.yml",
  defaults: [{ path: "", values: { layout: "doc" } }],
  repository: { url: "https://github.com/example/example", branch: "main", dir: "docs" },
  theme: { options: { logo: { light: "logo.svg" } } },
  search: { text: 300 },
  redirects: { "/old/": "/new/" },
  outputs: { llms: false },
};

const page: Page = {
  url: "/example/guide/install/",
  source: pos,
  frontMatter: { title: "Install", order: 1, status: "beta", agent: { edit: false }, custom: ["kept"] },
  title: "Install",
  lang: "en",
  dir: "ltr",
  headings: [{ depth: 2, id: "build", text: "Build", pos }],
  html: '<h1 data-source="docs/guide/install.md:3">Install</h1>',
  markdown: "# Install\n",
  kind: "doc",
};

const nav: NavTree = {
  docs: [{ title: "Guide", children: [{ title: "Install", url: page.url, match: "/example/guide/" }] }],
};

const site: Site = { config, pages: [page], nav, data: { versions: [1, 2] } };
const trail: Trail = [{ title: "Guide", url: "/example/guide/" }, { title: "Install", url: page.url }];
const pager: Pager = { next: { title: "Write", url: "/example/guide/write/" } };
const head: Head = {
  title: "Install",
  meta: [{ name: "description", content: "How to install" }, { name: "og:title", content: "Install", property: true }],
  links: [{ rel: "canonical", href: "https://example.com/example/guide/install/" }],
  jsonLd: [{ "@type": "TechArticle" }],
};
const island: Island = { name: "code-tabs", src: "/example/assets/code-tabs.js" };
const diagnostic: Diagnostic = { id: "link.broken", severity: "error", message: "No page at /missing/", pos, help: "Fix the link." };

const layout: Layout = ({ page: p }) => ({ type: "main", title: p.title });
const chrome: Chrome = ({ site: s }) => ({ type: "header", title: s.config.title });
const component: Component<{ kind: string }> = ({ props }) => ({ type: "aside", kind: props.kind });

const output: Output = {
  name: "example",
  async run(s, ctx) {
    ctx.report(diagnostic);
    return [{ path: "example.txt", contents: s.pages.map((p) => p.url).join("\n") }];
  },
};

const plugin: Plugin = {
  name: "example",
  content: (p) => p,
  model: (s) => s,
  outputs: (files) => files,
};
const code: CodeConfig = { plugins: [plugin] };

test("example values of every contract type type-check and carry what the contracts promise", async () => {
  assert.equal(site.pages[0]?.headings[0]?.pos.file, pos.file);
  assert.equal(pager.prev, undefined);
  assert.equal(trail.at(-1)?.url, page.url);
  assert.equal(head.meta.length, 2);
  assert.equal(island.name, "code-tabs");
  assert.equal(code.plugins[0]?.name, "example");
  assert.deepEqual(layout({ site, page, trail, pager, head, islands: [island] }), { type: "main", title: "Install" });
  assert.deepEqual(chrome({ site, page, trail, pager }), { type: "header", title: "Example" });
  assert.deepEqual(component({ props: { kind: "note" }, page, site, html: "" }), { type: "aside", kind: "note" });
  const reported: Diagnostic[] = [];
  const files = await output.run(site, { renderPage: async () => "", report: (d) => reported.push(d) });
  assert.deepEqual(files, [{ path: "example.txt", contents: page.url }]);
  assert.equal(reported.length, 1);
});
