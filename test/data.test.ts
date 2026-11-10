import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadData } from "../src/content/data.ts";
import { discover } from "../src/content/discover.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("YAML and JSON data files load keyed by file name, and other files under _data are ignored", async () => {
  const root = tree({
    "_data/authors.yml": "memo:\n  name: Memo\nnadia:\n  name: Nadia\n",
    "_data/menu.yaml": "- home\n- docs\n",
    "_data/team.json": "{ \"size\": 3 }\n",
    "_data/notes.txt": "not a data file\n",
  });
  try {
    const result = await loadData(root, await discover(root));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.data.authors, { memo: { name: "Memo" }, nadia: { name: "Nadia" } });
    assert.deepEqual(result.data.menu, ["home", "docs"]);
    assert.deepEqual(result.data.team, { size: 3 });
    assert.equal("notes" in result.data, false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("nested folders become nested keys", async () => {
  const root = tree({
    "_data/guides/install/steps.yml": "- download\n- extract\n",
    "_data/guides/intro.json": "{ \"short\": true }\n",
  });
  try {
    const result = await loadData(root, await discover(root));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.data, { guides: { install: { steps: ["download", "extract"] }, intro: { short: true } } });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a file and a same-named folder merge, the folder winning each key", async () => {
  const root = tree({
    "_data/authors.yml": "memo: from-file\nnadia: from-file\n",
    "_data/authors/memo.yml": "from-folder\n",
  });
  try {
    const result = await loadData(root, await discover(root));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.data.authors, { memo: "from-folder", nadia: "from-file" });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("parse errors are diagnostics with the line, and the other files still load", async () => {
  const root = tree({
    "_data/bad.yml": "a: 1\na: 2\n",
    "_data/bad.json": "{\n  \"a\": 1,,\n}\n",
    "_data/good.yml": "kept: true\n",
  });
  try {
    const result = await loadData(root, await discover(root));
    assert.deepEqual(result.data, { good: { kept: true } });
    assert.equal(result.diagnostics.length, 2);

    const yaml = result.diagnostics.find((d) => d.id === "data.invalid-yaml");
    assert.ok(yaml);
    assert.equal(yaml.severity, "error");
    assert.equal(yaml.pos?.file, "_data/bad.yml");
    assert.equal(yaml.pos?.line, 2);

    const json = result.diagnostics.find((d) => d.id === "data.invalid-json");
    assert.ok(json);
    assert.equal(json.severity, "error");
    assert.equal(json.pos?.file, "_data/bad.json");
    assert.equal(json.pos?.line, 2);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a missing _data folder is empty, and an empty YAML file is an empty mapping", async () => {
  const root = tree({ "a.md": "# A" });
  try {
    const missing = await loadData(root, await discover(root));
    assert.deepEqual(missing.data, {});
    assert.deepEqual(missing.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true });
  }

  const withEmpty = tree({ "_data/empty.yml": "" });
  try {
    const result = await loadData(withEmpty, await discover(withEmpty));
    assert.deepEqual(result.data, { empty: {} });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(withEmpty, { recursive: true });
  }
});

test("the navigation data of fixtures/docs-site loads with no diagnostics", async () => {
  const site = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const result = await loadData(site, await discover(site));
  assert.deepEqual(result.diagnostics, []);
  const navigation = result.data.navigation as { main?: unknown };
  assert.ok(Array.isArray(navigation.main));
});
