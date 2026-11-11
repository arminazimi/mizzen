import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { version } from "../src/index.ts";
import { build } from "../src/pipeline/build.ts";
import {
  CACHE_FORMAT,
  cacheKey,
  restoreCache,
  writeCache,
  type CacheKeyOptions,
  type CacheMissReason,
} from "../src/pipeline/cache.ts";

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

    // An entry written by an older format is never read, and the build replaces it.
    const manifestFile = join(entry, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: CACHE_FORMAT - 1 }));
    resetRenders();
    const afterOld = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(renders() > 0, "an old-format entry rebuilt the site");
    assert.deepEqual(afterOld.files, first.files);
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
    assert.equal(existsSync(join(root, ".mizzen")), false, "a build without `cache` writes no cache into the site");

    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true });
    assert.equal(entries(join(root, ".mizzen/cache")).length, 1, "`cache: true` uses `<root>/.mizzen/cache`");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

/** A site, theme, and outputs tree with at least one of every input `cacheKey` hashes. */
function keyFixture(): { root: string; theme: string; outputs: string; options: CacheKeyOptions } {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "index.md": "# Home\n",
    "_data/navigation.yml": "main:\n  - title: Home\n    url: /\n",
  });
  const theme = tree({ "src/index.ts": 'export const theme = { name: "cache" };\n' });
  const outputs = tree({ "html.ts": 'export const html = { name: "html", run: () => [] };\n' });
  return {
    root,
    theme,
    outputs,
    options: {
      root,
      sourceDir: root,
      config: loadConfig(root).config,
      themeRoot: theme,
      outputsDir: outputs,
      defaultLayout: "doc",
      themeFiles: ["styles.css"],
    },
  };
}

/** Removes a fixture folder. */
function clean(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

test("changing any declared input makes a new key", async () => {
  const { root, theme, outputs, options } = keyFixture();
  try {
    const base = await cacheKey(options);
    const differs = async (what: string, next: Partial<CacheKeyOptions> = {}): Promise<void> => {
      assert.notEqual(await cacheKey({ ...options, ...next }), base, `changing ${what} must miss`);
    };

    writeFileSync(join(root, "index.md"), "# Changed\n");
    await differs("page content");

    writeFileSync(join(root, "_data/navigation.yml"), "main:\n  - title: Changed\n    url: /\n");
    await differs("navigation");

    writeFileSync(join(root, "mizzen.yml"), "title: Changed\n");
    await differs("the config file", { config: loadConfig(root).config });

    writeFileSync(join(theme, "src/index.ts"), 'export const theme = { name: "changed" };\n');
    await differs("a theme file");

    writeFileSync(join(outputs, "html.ts"), 'export const html = { name: "html", run: () => [1] };\n');
    await differs("an output file");

    await differs("defaultLayout", { defaultLayout: "other" });
    await differs("themeFiles", { themeFiles: ["other.css"] });
    await differs("the engine version", { engineVersion: "0.0.1" });
    await differs("the runtime version", { runtimeVersion: "some-other-runtime" });
  } finally {
    clean(root, theme, outputs);
  }
});

test("the resolved config is part of the key, not only its file", async () => {
  const first = tree({ "index.md": "# Home\n" });
  const second = tree({ "index.md": "# Home\n" });
  try {
    // Neither site has a config: both take their title from the site folder's name, so their output differs.
    const shared = { themeRoot: first, outputsDir: first, defaultLayout: "doc" };
    const a = await cacheKey({ ...shared, root: first, sourceDir: first, config: loadConfig(first).config });
    const b = await cacheKey({ ...shared, root: second, sourceDir: second, config: loadConfig(second).config });
    assert.notEqual(a, b);
  } finally {
    clean(first, second);
  }
});

test("equal inputs produce one deterministic key", async () => {
  const { root, theme, outputs, options } = keyFixture();
  try {
    const base = await cacheKey(options);
    assert.equal(await cacheKey(options), base, "the same inputs always give the same key");
    assert.equal(
      await cacheKey({ ...options, themeFiles: ["styles.css", "styles.css"] }),
      base,
      "a repeated theme file is one input",
    );
    assert.equal(await cacheKey({ ...options, engineVersion: version }), base, "the engine version defaults to the engine's");
    assert.equal(
      await cacheKey({ ...options, runtimeVersion: `${process.versions.node}/${process.versions.icu ?? ""}` }),
      base,
      "the runtime defaults to the running Node and ICU versions",
    );

    // A timestamp change alone is not a content change.
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(root, "index.md"), later, later);
    assert.equal(await cacheKey(options), base);
  } finally {
    clean(root, theme, outputs);
  }
});

/** A finished build's output folder, and the entry `writeCache` records for it under a fixed key. */
async function entryFixture(cacheDir: string): Promise<{
  source: string;
  key: string;
  dir: string;
  files: string[];
  diagnostics: Diagnostic[];
}> {
  const source = tree({ "index.html": "<h1>Home</h1>\n", "assets/app.js": "console.log(1);\n" });
  const key = "a".repeat(64);
  const files = ["index.html", "assets/app.js"];
  const diagnostics: Diagnostic[] = [{ id: "test.one", severity: "warning", message: "One." }];
  await writeCache(cacheDir, key, source, files, diagnostics);
  return { source, key, dir: join(cacheDir, key), files, diagnostics };
}

test("restoreCache reports missing, corrupt, and incompatible entries and never copies bad output", async () => {
  const { parent, out, cacheDir } = scratch();
  let source: string | undefined;
  try {
    const key = "a".repeat(64);
    const reasons: CacheMissReason[] = [];
    const onMiss = (reason: CacheMissReason): void => {
      reasons.push(reason);
    };

    assert.equal(await restoreCache(cacheDir, key, out, { onMiss }), undefined);
    assert.deepEqual(reasons, ["missing"]);
    assert.equal(existsSync(out), false, "a miss writes nothing");

    const fixture = await entryFixture(cacheDir);
    source = fixture.source;
    const { dir, files, diagnostics } = fixture;
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");

    const hit = await restoreCache(cacheDir, key, out, { onMiss });
    assert.ok(hit !== undefined, "a valid entry is restored");
    assert.deepEqual(hit.files, [...files].sort());
    assert.deepEqual(hit.diagnostics, diagnostics);
    for (const file of files) {
      assert.deepEqual(readFileSync(join(hit.staging, file)), readFileSync(join(source, file)), `${file} is restored byte for byte`);
    }
    clean(hit.staging);
    assert.equal(existsSync(out), false, "a restore stages the output and leaves `out` alone");

    const expectMiss = async (reason: CacheMissReason): Promise<void> => {
      reasons.length = 0;
      assert.equal(await restoreCache(cacheDir, key, out, { onMiss }), undefined);
      assert.deepEqual(reasons, [reason]);
      assert.equal(existsSync(out), false);
    };

    writeFileSync(join(dir, "manifest.json"), "{ not json");
    await expectMiss("corrupt");

    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: CACHE_FORMAT - 1, key, engine: version, files, hashes: {}, diagnostics }),
    );
    await expectMiss("incompatible");

    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: CACHE_FORMAT, key, engine: "0.0.0", files, hashes: {}, diagnostics }),
    );
    await expectMiss("incompatible");

    // Well-shaped but not what was written: the manifest checksum covers the diagnostics too.
    writeFileSync(join(dir, "manifest.json"), manifest.replace("One.", "Changed."));
    await expectMiss("corrupt");

    // A file that no longer matches its hash, and a file that is gone.
    writeFileSync(join(dir, "manifest.json"), manifest);
    writeFileSync(join(dir, "out/index.html"), "tampered\n");
    await expectMiss("corrupt");
    rmSync(join(dir, "out/index.html"));
    await expectMiss("corrupt");

    // A key that is not a key can name nothing.
    reasons.length = 0;
    assert.equal(await restoreCache(cacheDir, "../escape", out, { onMiss }), undefined);
    assert.deepEqual(reasons, ["missing"]);

    // A rewritten entry is reusable again.
    await writeCache(cacheDir, key, source, files, diagnostics);
    const again = await restoreCache(cacheDir, key, out);
    assert.deepEqual(again?.files, [...files].sort());
    if (again !== undefined) clean(again.staging);
    assert.deepEqual(readdirSync(cacheDir), [key], "writing leaves one whole entry and no temporary folder");
  } finally {
    if (source !== undefined) clean(source);
    clean(parent);
  }
});

test("a file list that does not match the output writes no entry", async () => {
  const { parent, cacheDir } = scratch();
  const source = tree({ "index.html": "<h1>Home</h1>\n" });
  try {
    await writeCache(cacheDir, "b".repeat(64), source, ["index.html", "missing.html"], []);
    assert.equal(existsSync(cacheDir), false, "a partial build is never cached");
  } finally {
    clean(source, parent);
  }
});

test("a build that throws writes no whole-build entry", async () => {
  const root = tree({ "index.md": "---\ntitle: Home\n---\n# Home\n" });
  const theme = makeTheme("one");
  writeFileSync(join(theme, "layouts/broken.ts"), 'const broken = () => {\n  throw new Error("boom");\n};\nexport default broken;\n');
  const { parent, out, cacheDir } = scratch();
  try {
    await assert.rejects(build({ root, out, themeRoot: theme, defaultLayout: "broken", cache: true, cacheDir }));
    assert.equal(entries(cacheDir).length, 0, "a build that threw wrote no whole-build entry");
  } finally {
    clean(root, theme, parent);
  }
});
