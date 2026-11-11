/**
 * Clean-room proof that a build identity describes content, not the machine or the moment: two checkouts of one
 * site, at different absolute paths and different wall-clock times, write the same bytes, the same manifest, and
 * the same build hash. A semantic change moves only the identities that belong to the changed page.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verify } from "../src/cli/verify.ts";
import { MANIFEST_PATH } from "../src/outputs/build-hash.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** Folders a build writes into the fixture; a build cache is never input. */
const TRANSIENT = new Set([".mizzen", ".tmp", "node_modules", ".git"]);

/** A temporary parent folder; the caller removes it. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "build-determinism-"));
}

/** Copies the fixture under `parent` so a build cache cannot land inside the shared fixture. */
function copyFixture(parent: string): string {
  const root = join(parent, "docs-site");
  cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => TRANSIENT.has(part)),
  });
  return root;
}

/** A site with these files, under `parent`; the caller removes the parent. */
function writeSite(parent: string, files: Readonly<Record<string, string>>): string {
  const root = join(parent, "site");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every file under `root`, as `/`-separated relative paths in code-point order. */
function filesOf(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(/[\\/]/).join("/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface ManifestPage {
  readonly url: string;
  readonly source: string;
  readonly hashes: Readonly<Record<string, string>>;
  readonly outputs: readonly string[];
}

interface Manifest {
  readonly version: number;
  readonly pages: readonly ManifestPage[];
  readonly build: { readonly hash: string; readonly files: Readonly<Record<string, string>> };
}

function manifestOf(out: string): Manifest {
  return JSON.parse(readFileSync(join(out, MANIFEST_PATH), "utf8")) as Manifest;
}

function byUrl(manifest: Manifest): Map<string, ManifestPage> {
  return new Map(manifest.pages.map((entry) => [entry.url, entry]));
}

test("two clean builds from different checkout paths at different times are identical", async () => {
  const one = scratch();
  const two = scratch();
  try {
    const outOne = join(one, "out");
    const outTwo = join(two, "out");

    const first = await build({ root: copyFixture(one), out: outOne, themeRoot: THEME, defaultLayout: "doc" });
    // Cross a wall-clock second, so a timestamp in an identity would show up as a difference.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await build({ root: copyFixture(two), out: outTwo, themeRoot: THEME, defaultLayout: "doc" });

    assert.deepEqual(first.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(second.diagnostics.filter((d) => d.severity === "error"), []);

    const oneFiles = filesOf(outOne);
    assert.deepEqual(filesOf(outTwo), oneFiles, "the same files, in the same order");
    for (const path of oneFiles) {
      assert.ok(readFileSync(join(outOne, path)).equals(readFileSync(join(outTwo, path))), `${path} is the same byte for byte`);
    }

    const oneManifest = readFileSync(join(outOne, MANIFEST_PATH), "utf8");
    assert.equal(readFileSync(join(outTwo, MANIFEST_PATH), "utf8"), oneManifest, "the manifest is the same byte for byte");
    assert.equal(oneManifest.includes(one), false, "the checkout path does not leak into the manifest");
    assert.equal(oneManifest.includes(two), false, "the other checkout path does not leak either");

    assert.equal(manifestOf(outOne).build.hash, manifestOf(outTwo).build.hash, "the build hash is the same");
    assert.equal((await verify({ dir: outOne })).ok, true);
    assert.equal((await verify({ dir: outTwo })).ok, true);
  } finally {
    rmSync(one, { recursive: true });
    rmSync(two, { recursive: true });
  }
});

test("a semantic body change moves only the identities of the page it belongs to", async () => {
  const one = scratch();
  const two = scratch();
  try {
    const pages = {
      "a.md": "---\ntitle: A\n---\n# A\n\nBody A.\n",
      "b.md": "---\ntitle: B\n---\n# B\n\nBody B.\n",
    };
    const rootOne = writeSite(one, pages);
    const rootTwo = writeSite(two, pages);
    const outOne = join(one, "out");
    const outTwo = join(two, "out");
    await build({ root: rootOne, out: outOne, themeRoot: THEME, defaultLayout: "doc" });
    await build({ root: rootTwo, out: outTwo, themeRoot: THEME, defaultLayout: "doc" });

    writeFileSync(join(rootTwo, "a.md"), `${pages["a.md"]}An added sentence.\n`);
    await build({ root: rootTwo, out: outTwo, themeRoot: THEME, defaultLayout: "doc" });

    const before = manifestOf(outOne);
    const after = manifestOf(outTwo);
    const changedUrl = "/a/";
    const earlier = byUrl(before);
    const later = byUrl(after);
    assert.equal(later.size, earlier.size);

    for (const entry of before.pages) {
      const other = later.get(entry.url);
      assert.ok(other, `${entry.url} is still in the manifest`);
      if (entry.url === changedUrl) {
        assert.notDeepEqual(other.hashes, entry.hashes, "the changed page's identities move");
        assert.deepEqual(other.outputs, entry.outputs, "where the page writes does not move");
        assert.equal(other.source, entry.source, "its source does not move");
        continue;
      }
      assert.deepEqual(other, entry, `${entry.url} is untouched`);
    }

    const changedPage = before.pages.find((entry) => entry.url === changedUrl);
    assert.ok(changedPage, "the site has /a/");
    for (const output of changedPage.outputs) {
      assert.notEqual(after.build.files[output], before.build.files[output], `${output} changes with its page`);
    }
    for (const entry of before.pages) {
      if (entry.url === changedUrl) continue;
      for (const output of entry.outputs) {
        assert.equal(after.build.files[output], before.build.files[output], `${output} belongs to another page and stays`);
      }
    }

    assert.notEqual(after.build.hash, before.build.hash, "the whole-build hash changes with the content");
    assert.equal((await verify({ dir: outTwo })).ok, true);
  } finally {
    rmSync(one, { recursive: true });
    rmSync(two, { recursive: true });
  }
});
