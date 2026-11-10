import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** The render counter the test theme keeps on `globalThis`. */
type CacheGlobals = { cacheRenders?: number };

function renders(): number {
  return (globalThis as CacheGlobals).cacheRenders ?? 0;
}

function resetRenders(): void {
  (globalThis as CacheGlobals).cacheRenders = 0;
}

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cache-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary folder for the output and the cache. */
function scratch(): { parent: string; out: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "cache-out-"));
  return { parent, out: join(parent, "site"), cacheDir: join(parent, "cache") };
}

/** Every file under `dir` as path → bytes, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

/** The source of a minimal theme layout: it renders the site title, the navigation, and a marker, and counts renders. */
function layoutSource(marker: string): string {
  return `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) => {
  const globals = globalThis as { cacheRenders?: number };
  globals.cacheRenders = (globals.cacheRenders ?? 0) + 1;
  return h(
    "html",
    null,
    h(
      "body",
      null,
      h("pre", { id: "title" }, props.site.config.title),
      h("pre", { id: "nav" }, JSON.stringify(props.site.nav)),
      h("pre", { id: "marker" }, ${JSON.stringify(marker)}),
      h("div", { dangerouslySetInnerHTML: { __html: props.page.html } }),
    ),
  );
};

export default doc;
`;
}

/** A temporary theme whose one layout renders `marker`, so a theme change is visible in the output. */
function makeTheme(marker: string): string {
  const root = mkdtempSync(join(tmpdir(), "cache-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "cache-test", folders: ["layouts"] };\n');
  writeFileSync(join(root, "layouts/doc.ts"), layoutSource(marker));
  return root;
}

/** The cache entry folders: the ones named after a key. */
function entries(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map((entry) => join(cacheDir, entry.name));
}

test("a second build with no changes is a cache hit and writes identical bytes", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "guide/a.md": "---\ntitle: A\n---\n# A\n",
  });
  const theme = makeTheme("one");
  const { parent, out, cacheDir } = scratch();
  try {
    resetRenders();
    const first = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const cold = snapshot(out);
    assert.ok(renders() > 0, "the cold build rendered");

    // A timestamp change alone is not a content change.
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(root, "index.md"), later, later);

    resetRenders();
    const second = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(renders(), 0, "the cache hit skipped rendering every page");
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.diagnostics, first.diagnostics);
    assert.deepEqual(snapshot(out), cold, "the cached build wrote the same bytes as the cold build");
    assert.equal(entries(cacheDir).length, 1, "the cache holds one entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a second build of fixtures/docs-site is at least three times faster than a cold one", { timeout: 120_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "cache-docs-"));
  const cacheDir = join(parent, "cache");
  const out = (name: string): string => join(parent, name);
  try {
    // Warm the engine's module cache first, so the baseline measures the build rather than the first import.
    await build({ root: FIXTURE, out: out("warmup"), themeRoot: THEME, defaultLayout: "doc" });

    const coldStart = performance.now();
    const cold = await build({ root: FIXTURE, out: out("cold"), themeRoot: THEME, defaultLayout: "doc" });
    const coldMs = performance.now() - coldStart;

    // Populate the cache with one cold build; the next one is the hit under test.
    await build({ root: FIXTURE, out: out("populate"), themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });

    let warmMs = Number.POSITIVE_INFINITY;
    let hit = cold;
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      hit = await build({ root: FIXTURE, out: out(`hit-${i}`), themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
      warmMs = Math.min(warmMs, performance.now() - started);
    }

    assert.deepEqual(hit.files, cold.files);
    assert.deepEqual(hit.diagnostics, cold.diagnostics);
    assert.deepEqual(snapshot(out("hit-0")), snapshot(out("cold")), "the cached build matches the cold build byte for byte");
    assert.ok(
      warmMs * 3 <= coldMs,
      `a cache hit should be at least 3x faster: cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(1)}ms`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changing a page invalidates the cache, and the new output is written", async () => {
  const root = tree({ "index.md": "---\ntitle: Home\n---\n# Home\n" });
  const theme = makeTheme("one");
  const { parent, out, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.doesNotMatch(readFileSync(join(out, "index.html"), "utf8"), /Changed/);

    writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Changed\n");
    resetRenders();
    const second = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(renders() > 0, "the changed page was built again");
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /Changed/);
    assert.ok(second.files.includes("index.html"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changing the config invalidates every page", async () => {
  const root = tree({
    "mizzen.yml": "title: Before\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "guide/a.md": "---\ntitle: A\n---\n# A\n",
  });
  const theme = makeTheme("one");
  const { parent, out, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });

    writeFileSync(join(root, "mizzen.yml"), "title: After\n");
    resetRenders();
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(renders(), 2, "the config change rebuilt every page");
    for (const page of ["index.html", "guide/a/index.html"]) {
      assert.match(readFileSync(join(out, page), "utf8"), /After/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changing the navigation invalidates every page", async () => {
  const root = tree({
    "mizzen.yml": "title: Nav\n",
    "_data/navigation.yml": "main:\n  - title: Before\n    url: /\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "guide/a.md": "---\ntitle: A\n---\n# A\n",
  });
  const theme = makeTheme("one");
  const { parent, out, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });

    writeFileSync(join(root, "_data/navigation.yml"), "main:\n  - title: After\n    url: /\n");
    resetRenders();
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(renders(), 2, "the navigation change rebuilt every page");
    for (const page of ["index.html", "guide/a/index.html"]) {
      assert.match(readFileSync(join(out, page), "utf8"), /After/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changing the theme invalidates the build", async () => {
  const root = tree({ "index.md": "---\ntitle: Home\n---\n# Home\n" });
  const first = makeTheme("before");
  const second = makeTheme("after");
  const { parent, out, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: first, defaultLayout: "doc", cache: true, cacheDir });
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /before/);

    resetRenders();
    await build({ root, out, themeRoot: second, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(renders() > 0, "the theme change rebuilt the page");
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /after/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a corrupt or missing cache falls back to a cold build", async () => {
  const root = tree({ "index.md": "---\ntitle: Home\n---\n# Home\n" });
  const theme = makeTheme("one");
  const { parent, out, cacheDir } = scratch();
  try {
    const first = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const cold = snapshot(out);

    // Corrupt one file inside the entry: its hash no longer matches the manifest, so the entry is not trusted.
    const [entry] = entries(cacheDir);
    assert.ok(entry !== undefined, "the cold build wrote an entry");
    writeFileSync(join(entry, "out/index.html"), "not the built page\n");

    resetRenders();
    const afterCorrupt = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(renders() > 0, "a corrupt entry rebuilt the site");
    assert.deepEqual(afterCorrupt.files, first.files);
    assert.deepEqual(snapshot(out), cold);

    // A missing cache is just a miss.
    rmSync(cacheDir, { recursive: true, force: true });
    resetRenders();
    const afterMissing = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(renders() > 0, "a missing cache rebuilt the site");
    assert.deepEqual(afterMissing.files, first.files);
    assert.deepEqual(snapshot(out), cold);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the cache is off by default and lives under the site root when on", async () => {
  const root = tree({ "index.md": "---\ntitle: Home\n---\n# Home\n" });
  const theme = makeTheme("one");
  const { parent, out } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc" });
    assert.equal(existsSync(join(root, ".slipway")), false, "a build without `cache` writes no cache into the site");

    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true });
    assert.equal(entries(join(root, ".slipway/cache")).length, 1, "`cache: true` uses `<root>/.slipway/cache`");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
