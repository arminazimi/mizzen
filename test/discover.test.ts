import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "discover-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the dashboard folder of fixtures/docs-site is an app page", async () => {
  const site = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const files = await discover(site, { exclude: ["generate.mjs"] });
  const dashboard = files.filter((f) => f.path.startsWith("dashboard/"));
  assert.ok(dashboard.length > 1);
  assert.ok(dashboard.every((f) => f.kind === "app"));
  assert.ok(files.some((f) => f.path === "quickstart.md" && f.kind === "doc"));
  assert.ok(!files.some((f) => f.path === "generate.mjs"));
  assert.deepEqual(files.map((f) => f.path), files.map((f) => f.path).sort());
});

test("it skips underscore folders (except _data), dotfiles, node_modules, and excluded paths", async () => {
  const root = tree({
    "a.md": "# A",
    "_layouts/x.html": "x",
    "_data/navigation.yml": "- a",
    ".hidden": "x",
    ".github/ci.yml": "x",
    "node_modules/p/index.js": "x",
    "drafts/b.md": "# B",
    "docs/_private/c.md": "# C",
    "docs/d.md": "# D",
  });
  try {
    const files = await discover(root, { exclude: ["drafts"] });
    assert.deepEqual(files, [
      { path: "_data/navigation.yml", kind: "data" },
      { path: "a.md", kind: "doc" },
      { path: "docs/d.md", kind: "doc" },
    ]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("include keeps a path that would be skipped", async () => {
  const root = tree({ ".well-known/security.txt": "x", "a.md": "x" });
  try {
    const files = await discover(root, { include: [".well-known"] });
    assert.deepEqual(files.map((f) => f.path), [".well-known/security.txt", "a.md"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("HTML with front matter is a doc, plain HTML is an asset, and an index.html without front matter makes an app page", async () => {
  const root = tree({
    "page.html": "---\ntitle: P\n---\n<p>x</p>",
    "plain.html": "<p>x</p>",
    "app/index.html": "<!doctype html>",
    "app/deep/page.md": "# not a doc",
    "app/app.js": "x",
    "site/index.html": "---\ntitle: S\n---\n",
    "site/note.md": "# N",
  });
  try {
    const kinds = Object.fromEntries((await discover(root)).map((f) => [f.path, f.kind]));
    assert.deepEqual(kinds, {
      "app/app.js": "app",
      "app/deep/page.md": "app",
      "app/index.html": "app",
      "page.html": "doc",
      "plain.html": "asset",
      "site/index.html": "doc",
      "site/note.md": "doc",
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("order is by code point, not locale", async () => {
  const root = tree({ "b.md": "", "a.md": "", "Z/x.md": "", "é.md": "" });
  try {
    assert.deepEqual((await discover(root)).map((f) => f.path), ["Z/x.md", "a.md", "b.md", "é.md"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
