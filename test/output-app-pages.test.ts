import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "../src/contracts/content.ts";
import type { DiscoveredFile } from "../src/content/discover.ts";
import { discover } from "../src/content/discover.ts";
import { permalink } from "../src/content/permalink.ts";
import { isAppPage } from "../src/outputs/app-pages.ts";

const pos = { file: "dashboard/index.html", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

test("every output skips the dashboard of fixtures/docs-site and keeps every doc", async () => {
  const site = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const pages = (await discover(site))
    .filter((f): f is DiscoveredFile & { kind: "doc" | "app" } => f.kind === "doc" || f.kind === "app")
    .map((f) => page(permalink(f.path), f.kind));
  const options = { pages };
  const dashboards = pages.filter((p) => p.kind === "app").map((p) => p.url);
  assert.ok(dashboards.includes("/dashboard/"), dashboards.join(" "));
  assert.ok(pages.some((p) => p.url === "/quickstart/" && p.kind === "doc"));

  // What each output would touch, from a page's URL: search indexes the written HTML, the llms files and the twins
  // point at the Markdown twin, and the source map carries the page URL itself. Nothing an app page emits is kept.
  const outputs: readonly (readonly [string, (url: string) => string])[] = [
    ["search", (url) => `${url}index.html`],
    ["llms.txt", (url) => `${url}index.md`],
    ["llms-full.txt", (url) => `${url}index.md`],
    ["twins", (url) => `${url}index.md`],
    ["sourcemap", (url) => url],
  ];
  for (const [name, emit] of outputs) {
    for (const p of pages) {
      assert.equal(isAppPage(emit(p.url), options), p.kind === "app", `${name}: ${p.url}`);
    }
  }

  // The files of the app page are skipped too, though the model lists none of them: the root they share decides.
  for (const file of ["/dashboard/index.html", "/dashboard/style.css", "/dashboard/dashboard.js", "/dashboard/data.json"]) {
    assert.equal(isAppPage(file, options), true, file);
  }
});

test("every URL form an output can see reduces to the same root", () => {
  const options = { pages: [page("/dashboard/", "app")] };
  for (const url of ["/dashboard/", "/dashboard", "/dashboard/index.html", "/dashboard/index.htm", "/dashboard/deep/app.js"]) {
    assert.equal(isAppPage(url, options), true, url);
  }
});

test("a name that only starts with the root is kept, because the match stops at the path segment", () => {
  const options = { pages: [page("/dashboard/", "app")] };
  for (const url of ["/", "/dashboard-2/", "/dashboards/", "/dashboard.css", "/guide/", "/Dashboard/"]) {
    assert.equal(isAppPage(url, options), false, url);
  }
});

test("a nested app page skips its files but not its siblings", () => {
  const options = { pages: [page("/tools/repl/", "app"), page("/guide/", "doc")] };
  assert.equal(isAppPage("/tools/repl/", options), true);
  assert.equal(isAppPage("/tools/repl/wasm/repl.js", options), true);
  assert.equal(isAppPage("/tools/", options), false);
  assert.equal(isAppPage("/tools/other/", options), false);
  assert.equal(isAppPage("/guide/", options), false);
});

test("the query and the hash of a URL do not change the answer", () => {
  const options = { pages: [page("/dashboard/", "app")] };
  assert.equal(isAppPage("/dashboard/?page=2", options), true);
  assert.equal(isAppPage("/dashboard/index.html#top", options), true);
  assert.equal(isAppPage("/guide/?page=2", options), false);
});

test("the site root is never an app page, even when a page of kind app sits there", () => {
  const options = { pages: [page("/", "app")] };
  assert.equal(isAppPage("/", options), false);
  assert.equal(isAppPage("/dashboard/", options), false);
});

test("with no app pages in the model nothing is skipped", () => {
  const options = { pages: [page("/guide/", "doc"), page("/assets/theme.css", "asset")] };
  assert.equal(isAppPage("/guide/", options), false);
  assert.equal(isAppPage("/assets/theme.css", options), false);
  assert.equal(isAppPage("/dashboard/", options), false);
});
