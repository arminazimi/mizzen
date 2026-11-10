import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OutputContext } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { sourcemap } from "../src/outputs/sourcemap.ts";
import { build } from "../src/pipeline/build.ts";

/** The fixture repository: the site is in `docs/`, and `docs/` is the site root. */
const REPOSITORY = fileURLToPath(new URL("../fixtures/subfolder-repo", import.meta.url));
const SITE = join(REPOSITORY, "docs");
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

interface PageEntry {
  readonly url: string;
  readonly source: string;
}

interface SourceMap {
  readonly version: number;
  readonly pages: readonly PageEntry[];
}

/** The source map reads only the model, so rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the source map never renders a page")),
  report: () => {},
};

async function model() {
  const { site, diagnostics } = await buildModel(SITE);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  return site;
}

test("the fixture repository holds the site in docs/ and names that folder in its config", async () => {
  const site = await model();

  assert.equal(site.config.title, "Subfolder");
  assert.equal(site.config.repository?.dir, "docs");
  assert.ok(existsSync(join(REPOSITORY, "README.md")), "the repository root has a file outside the site");
  assert.ok(existsSync(join(SITE, "mizzen.yml")), "the site root is docs/");
});

test("every page's source file is relative to the repository root, not the site root", async () => {
  const site = await model();

  assert.ok(site.pages.length > 0, "the fixture has pages");
  for (const page of site.pages) {
    assert.ok(page.source.file.startsWith("docs/"), `${page.source.file} names the repository folder`);
    assert.ok(!page.source.file.split("/").includes(".."), `${page.source.file} has no parent segment`);
    assert.ok(existsSync(join(REPOSITORY, page.source.file)), `${page.source.file} exists under the repository root`);
  }

  const install = site.pages.find((page) => page.url === "/guide/install/");
  assert.equal(install?.source.file, "docs/guide/install.md");
});

test("the source map names docs/ paths, so a tool can open them from the repository root", async () => {
  const site = await model();
  const files = await sourcemap.run(site, ctx);

  assert.equal(files.length, 1);
  const map = JSON.parse(String(files[0]!.contents)) as SourceMap;
  const install = map.pages.find((entry) => entry.url === "/guide/install/");
  assert.equal(install?.source, "docs/guide/install.md");

  for (const entry of map.pages) {
    assert.ok(entry.source.startsWith("docs/"), `${entry.url} names the repository folder`);
    assert.ok(existsSync(join(REPOSITORY, entry.source)), `${entry.source} exists under the repository root`);
  }
});

test("a build's edit link, edit prompt, and feedback name docs/ paths", async () => {
  const parent = mkdtempSync(join(tmpdir(), "subfolder-out-"));
  try {
    const result = await build({ root: SITE, out: join(parent, "site"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const html = readFileSync(join(parent, "site/guide/install/index.html"), "utf8");
    assert.match(
      html,
      /href="https:\/\/github\.com\/example\/subfolder-repo\/edit\/main\/docs\/guide\/install\.md"/,
      "the edit link points at the source under docs/",
    );
    assert.match(
      html,
      /data-prompt="Edit docs\/guide\/install\.md:\d+\./,
      "the edit prompt names the source relative to the repository root",
    );
    assert.match(html, /Source%3A%20docs%2Fguide%2Finstall\.md/, "the feedback link names the same source");

    const written = JSON.parse(readFileSync(join(parent, "site/sourcemap.json"), "utf8")) as SourceMap;
    assert.equal(written.pages.find((entry) => entry.url === "/guide/install/")?.source, "docs/guide/install.md");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
