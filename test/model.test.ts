import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "model-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("fixtures/docs-site builds a model with hundreds of pages and no errors", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site, diagnostics } = await buildModel(root);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  assert.ok(site.pages.length >= 500, `got ${site.pages.length} pages`);
  const urls = site.pages.map((p) => p.url);
  assert.deepEqual(urls, [...urls].sort());
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(site.pages.some((p) => p.kind === "app" && p.url === "/dashboard/"));
});

test("a page takes its title, url, language, and headings", async () => {
  const root = tree({
    "mizzen.yml": "title: T\nbase: /docs\n",
    "guide/install.md": "---\norder: 2\n---\n# Install\n\n## Steps\n",
  });
  const { site, diagnostics } = await buildModel(root);
  assert.deepEqual(diagnostics, []);
  const page = site.pages[0]!;
  assert.equal(page.url, "/docs/guide/install/");
  assert.equal(page.title, "Install");
  assert.equal(page.lang, "en");
  assert.equal(page.headings.length, 2);
  assert.equal(page.headings[1]!.pos.line, 6);
  assert.equal(page.source.file, "guide/install.md");
});

test("two pages with one URL are an error naming both sources", async () => {
  const root = tree({ "a.md": "---\npermalink: /x/\n---\nA\n", "b.md": "---\npermalink: /x/\n---\nB\n" });
  const { diagnostics } = await buildModel(root);
  const dup = diagnostics.filter((d) => d.id === "page.duplicate-url");
  assert.equal(dup.length, 1);
  assert.equal(dup[0]!.severity, "error");
  assert.match(dup[0]!.message, /a\.md/);
  assert.match(dup[0]!.message, /b\.md/);
});

test("defaults apply by folder, a page wins, and published: false leaves a page out", async () => {
  const root = tree({
    "mizzen.yml": "defaults:\n  - path: guide\n    values:\n      layout: doc\n      lang: fa\n",
    "guide/a.md": "# A\n",
    "guide/b.md": "---\nlang: en\n---\n# B\n",
    "guide/c.md": "---\npublished: false\n---\n# C\n",
  });
  const { site } = await buildModel(root);
  assert.deepEqual(site.pages.map((p) => [p.url, p.lang, p.dir]), [
    ["/guide/a/", "fa", "rtl"],
    ["/guide/b/", "en", "ltr"],
  ]);
});
