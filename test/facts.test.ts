import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { applyFacts, loadFacts } from "../src/model/facts.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "facts-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary facts folder: `package.json` marks it as an ES module so its `.ts` files import. */
function factsTree(files: Record<string, string>): string {
  return tree({ ...files, "package.json": JSON.stringify({ type: "module", name: "temp-facts" }) });
}

/** A temporary site with its config. */
function siteTree(files: Record<string, string> = {}): string {
  return tree({ "mizzen.yml": "title: Facts\n", ...files });
}

test("facts load in file-name order and land at data[name] with an absolute root and sourceDir", async () => {
  const root = siteTree({ "guide/install.md": "# Install\n" });
  const dir = factsTree({
    "zebra.ts": `export const zebra = { name: "zebra", compute: () => ({ stripes: 9 }) };\n`,
    "alpha.ts": `export const alpha = {
  name: "alpha",
  compute({ root, sourceDir, pages, config }) {
    return { root, sourceDir, pages: pages.map((page) => page.url), title: config.title };
  },
};\n`,
  });
  try {
    const loaded = await loadFacts(dir);
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.facts.map((fact) => fact.name), ["alpha", "zebra"]);

    const model = await buildModel(root);
    const result = await applyFacts({ site: model.site, root, sourceDir: root, dir });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.site.data.zebra, { stripes: 9 });
    assert.deepEqual(result.site.data.alpha, {
      root,
      sourceDir: root,
      pages: ["/guide/install/"],
      title: "Facts",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fact whose name differs from its file is an error and is skipped", async () => {
  const dir = factsTree({
    "wrong.ts": `export const wrong = { name: "other", compute: () => 1 };\n`,
    "right.ts": `export const right = { name: "right", compute: () => 2 };\n`,
  });
  try {
    const loaded = await loadFacts(dir);
    assert.deepEqual(
      loaded.facts.map((fact) => fact.name),
      ["right"],
    );
    assert.equal(loaded.diagnostics.length, 1);
    assert.equal(loaded.diagnostics[0]!.id, "facts.load-failed");
    assert.equal(loaded.diagnostics[0]!.severity, "error");
    assert.match(loaded.diagnostics[0]!.message, /wrong\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing fact is a warning, it is skipped, and the other facts still run", async () => {
  const root = siteTree();
  const dir = factsTree({
    "bad.ts": `export const bad = { name: "bad", compute: () => { throw new Error("boom"); } };\n`,
    "good.ts": `export const good = { name: "good", compute: () => "kept" };\n`,
  });
  try {
    const model = await buildModel(root);
    const result = await applyFacts({ site: model.site, root, sourceDir: root, dir });
    assert.equal(result.site.data.good, "kept");
    assert.equal(Object.hasOwn(result.site.data, "bad"), false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.id, "facts.compute-failed");
    assert.equal(result.diagnostics[0]!.severity, "warning");
    assert.match(result.diagnostics[0]!.message, /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a _data file wins over the fact, with no diagnostic", async () => {
  const root = siteTree({ "_data/echo.yml": "source: site\n" });
  const dir = factsTree({
    "echo.ts": `export const echo = { name: "echo", compute: () => ({ source: "fact" }) };\n`,
  });
  try {
    const model = await buildModel(root);
    const result = await applyFacts({ site: model.site, root, sourceDir: root, dir });
    assert.deepEqual(result.site.data.echo, { source: "site" });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two runs give deep-equal data with identical key order", async () => {
  const root = siteTree({ "_data/mmm.yml": "from: data\n" });
  const dir = factsTree({
    "zzz.ts": `export const zzz = { name: "zzz", compute: () => ({ z: 1 }) };\n`,
    "aaa.ts": `export const aaa = { name: "aaa", compute: () => ({ a: 1 }) };\n`,
  });
  try {
    const firstModel = await buildModel(root);
    const first = await applyFacts({ site: firstModel.site, root, sourceDir: root, dir });
    const secondModel = await buildModel(root);
    const second = await applyFacts({ site: secondModel.site, root, sourceDir: root, dir });

    assert.deepEqual(first.site.data, second.site.data);
    assert.deepEqual(Object.keys(first.site.data), Object.keys(second.site.data));
    // The facts the engine ships with are already in the model; this folder adds its own three beside them.
    const keys = [...new Set([...Object.keys(firstModel.site.data), "aaa", "mmm", "zzz"])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    assert.deepEqual(Object.keys(first.site.data), keys);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fact that returns undefined is skipped with a diagnostic", async () => {
  const root = siteTree();
  const dir = factsTree({
    "empty.ts": `export const empty = { name: "empty", compute: () => undefined };\n`,
  });
  try {
    const model = await buildModel(root);
    const result = await applyFacts({ site: model.site, root, sourceDir: root, dir });
    assert.equal(Object.hasOwn(result.site.data, "empty"), false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.id, "facts.compute-failed");
    assert.equal(result.diagnostics[0]!.severity, "warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
