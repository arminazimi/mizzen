import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";
import { copyAssets } from "../src/pipeline/assets.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "assets-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "assets-out-"));
}

test("the dashboard app page of fixtures/docs-site is byte-identical in the output", async () => {
  const site = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const out = outDir();
  try {
    const files = await discover(site, { exclude: ["generate.mjs"] });
    const result = await copyAssets({ source: site, out, files });
    for (const name of ["dashboard/index.html", "dashboard/dashboard.js", "dashboard/style.css", "dashboard/data.json"]) {
      assert.deepEqual(readFileSync(join(out, name)), readFileSync(join(site, name)), name);
      assert.ok(result.files.some((f) => f.path === name && f.from === name), name);
    }
  } finally {
    rmSync(out, { recursive: true });
  }
});

test("site assets keep their paths, and docs and _data files are not copied", async () => {
  const root = tree({
    "a.md": "# A",
    "_data/navigation.yml": "- a",
    "images/logo.png": "\u0089PNG\r\n\u001a\n",
    "plain.html": "<p>x</p>",
  });
  const out = outDir();
  try {
    const result = await copyAssets({ source: root, out, files: await discover(root) });
    assert.deepEqual(result.files.map((f) => f.path), ["images/logo.png", "plain.html"]);
    assert.deepEqual(readFileSync(join(out, "images/logo.png")), readFileSync(join(root, "images/logo.png")));
    assert.deepEqual(readFileSync(join(out, "plain.html")), readFileSync(join(root, "plain.html")));
    assert.equal(existsSync(join(out, "a.md")), false);
    assert.equal(existsSync(join(out, "_data/navigation.yml")), false);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(out, { recursive: true });
  }
});

test("theme assets land under assets/theme with the hash of their bytes in the name", async () => {
  const root = tree({ "a.md": "# A" });
  const themeRoot = tree({ "assets/css/main.css": "body { color: ink; }\n", "assets/logo.svg": "<svg></svg>" });
  const out = outDir();
  try {
    const result = await copyAssets({ source: root, out, files: await discover(root), themeRoot, themeFiles: ["assets/css/main.css", "assets/logo.svg"] });
    assert.deepEqual(result.files.map((f) => f.path), [...result.files.map((f) => f.path)].sort());
    const css = result.files.find((f) => f.from === "assets/css/main.css");
    assert.ok(css);
    assert.match(css.path, /^assets\/theme\/assets\/css\/main-[0-9a-f]{16}\.css$/);
    const svg = result.files.find((f) => f.from === "assets/logo.svg");
    assert.ok(svg);
    assert.match(svg.path, /^assets\/theme\/assets\/logo-[0-9a-f]{16}\.svg$/);
    assert.deepEqual(readFileSync(join(out, css.path)), readFileSync(join(themeRoot, "assets/css/main.css")));
  } finally {
    rmSync(root, { recursive: true });
    rmSync(themeRoot, { recursive: true });
    rmSync(out, { recursive: true });
  }
});

test("the hashed name changes when the bytes change and is stable when they do not", async () => {
  const root = tree({ "a.md": "# A" });
  const themeRoot = tree({ "main.css": "body {}\n" });
  const out = outDir();
  try {
    const options = { source: root, out, files: [], themeRoot, themeFiles: ["main.css"] };
    const first = await copyAssets(options);
    const same = await copyAssets(options);
    assert.deepEqual(same.files, first.files);
    writeFileSync(join(themeRoot, "main.css"), "body { color: ink; }\n");
    const changed = await copyAssets(options);
    assert.equal(changed.files.length, 1);
    assert.notEqual(changed.files[0]?.path, first.files[0]?.path);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(themeRoot, { recursive: true });
    rmSync(out, { recursive: true });
  }
});

test("an extensionless theme file keeps its name with the hash appended", async () => {
  const root = tree({ "a.md": "# A" });
  const themeRoot = tree({ "LICENSE": "MIT" });
  const out = outDir();
  try {
    const result = await copyAssets({ source: root, out, files: [], themeRoot, themeFiles: ["LICENSE"] });
    assert.deepEqual(result.files.map((f) => f.path), [`assets/theme/LICENSE-${result.files[0]?.hash}`]);
    assert.match(result.files[0]?.hash ?? "", /^[0-9a-f]{16}$/);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(themeRoot, { recursive: true });
    rmSync(out, { recursive: true });
  }
});
