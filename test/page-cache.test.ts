import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "../src/index.ts";
import { loadMarkdownPlugins } from "../src/markdown/parse.ts";
import { buildModel } from "../src/model/build.ts";
import { build } from "../src/pipeline/build.ts";
import { PAGE_CACHE_FORMAT, pageCache, parseMarkdownCached, parseMarkdownWithCache } from "../src/pipeline/page-cache.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "page-cache-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary folder for a cache, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "page-cache-"));
}

/** The page cache files a build wrote, sorted. Throws when a temporary file is left behind. */
function entries(dir: string): string[] {
  const names = readdirSync(dir).sort();
  for (const name of names) {
    assert.match(name, /^[0-9a-f]{64}\.json$/, `unexpected cache file ${name}`);
  }
  return names;
}

test("a second build parses no pages, and changing one page parses only that page", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "a.md": "# A\n\nA body.\n",
    "b.md": "# B\n\nB body.\n",
    "c.md": "# C\n\nC body.\n",
  });
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const first = await buildModel(root, { pageCacheDir: pages });
    assert.equal(first.parsedPages, 3);
    assert.equal(entries(pages).length, 3);

    const second = await buildModel(root, { pageCacheDir: pages });
    assert.equal(second.parsedPages, 0, "an unchanged build parses nothing");
    assert.deepEqual(second.site, first.site);
    assert.deepEqual(second.diagnostics, first.diagnostics);

    writeFileSync(join(root, "b.md"), "# B\n\nB body changed.\n");
    const third = await buildModel(root, { pageCacheDir: pages });
    assert.equal(third.parsedPages, 1, "only the changed page is parsed again");
    assert.notDeepEqual(third.site, first.site);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("changing an included file re-parses only the pages that include it", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "_snippets/shared.md": "One.\n",
    "a.md": "---\ntitle: A\n---\nA intro.\n\n::include[_snippets/shared.md]\n",
    "b.md": "---\ntitle: B\n---\nB intro.\n\n::include[_snippets/shared.md]\n",
    "c.md": "---\ntitle: C\n---\nC only.\n",
  });
  const cacheDir = scratch();
  try {
    assert.equal((await buildModel(root, { pageCacheDir: cacheDir })).parsedPages, 3);
    assert.equal((await buildModel(root, { pageCacheDir: cacheDir })).parsedPages, 0);

    writeFileSync(join(root, "_snippets/shared.md"), "Two.\n");
    assert.equal(
      (await buildModel(root, { pageCacheDir: cacheDir })).parsedPages,
      2,
      "the two pages that include the snippet miss; the third page hits",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a page cache hit yields the same site as a cold build, source positions included", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "guide/install.md": "---\ntitle: Install\n---\n\n# Install\n\n## Steps\n",
  });
  const cacheDir = scratch();
  try {
    const cold = await buildModel(root);
    assert.equal(cold.parsedPages, 1);
    assert.deepEqual(
      cold.site.pages[0]!.headings.map((h) => h.pos.line),
      [5, 7],
    );

    const first = await buildModel(root, { pageCacheDir: cacheDir });
    assert.equal(first.parsedPages, 1);
    const warm = await buildModel(root, { pageCacheDir: cacheDir });
    assert.equal(warm.parsedPages, 0);
    assert.deepEqual(warm.site, cold.site, "the cached tree produces the same site");
    assert.deepEqual(warm.diagnostics, cold.diagnostics);
    assert.deepEqual(
      warm.site.pages[0]!.headings.map((h) => h.pos.line),
      [5, 7],
      "cached positions refer to the full source file, as a cold parse's do",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the key changes with the body, the body line, and the plugins and engine version", async () => {
  const cacheDir = scratch();
  const body = "# Hello\n";
  const options = { engineVersion: "1.0.0", plugins: [{ name: "gfm", order: 0 }] } as const;
  try {
    const base = pageCache(join(cacheDir, "pages"), options);
    const key = await base.key(body, 1);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(await base.key(body, 2), key);
    assert.notEqual(await base.key("# Other\n", 1), key);

    const reordered = pageCache(join(cacheDir, "pages"), {
      engineVersion: "1.0.0",
      plugins: [{ name: "gfm", order: 1 }],
    });
    const renamed = pageCache(join(cacheDir, "pages"), {
      engineVersion: "1.0.0",
      plugins: [{ name: "slug", order: 0 }],
    });
    const bumped = pageCache(join(cacheDir, "pages"), {
      engineVersion: "1.0.1",
      plugins: [{ name: "gfm", order: 0 }],
    });

    assert.equal((await parseMarkdownWithCache(body, 1, base)).parsed, true);
    const hit = pageCache(join(cacheDir, "pages"), options);
    assert.ok(await hit.get(key), "an equal configuration hits");

    assert.notEqual(await reordered.key(body, 1), key, "a plugin order change makes a new key");
    assert.notEqual(await renamed.key(body, 1), key, "a plugin name change makes a new key");
    assert.notEqual(await bumped.key(body, 1), key, "an engine version change makes a new key");
    assert.equal((await parseMarkdownWithCache(body, 1, reordered)).parsed, true);
    assert.equal((await parseMarkdownWithCache(body, 1, bumped)).parsed, true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the default key uses the loaded plugins' names and orders", async () => {
  const cacheDir = scratch();
  try {
    const auto = pageCache(join(cacheDir, "auto"));
    const plugins = await loadMarkdownPlugins();
    const explicit = pageCache(join(cacheDir, "explicit"), {
      plugins: plugins.map(({ name, order }) => ({ name, order })),
    });
    assert.equal(await auto.key("# Hi\n"), await explicit.key("# Hi\n"));

    const reordered = pageCache(join(cacheDir, "reordered"), {
      plugins: [...plugins].reverse().map(({ name, order }) => ({ name, order })),
    });
    assert.notEqual(await auto.key("# Hi\n"), await reordered.key("# Hi\n"));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a missing, corrupt, format-mismatched, or stale entry is a miss", async () => {
  const cacheDir = scratch();
  const options = { engineVersion: "1.0.0", plugins: [{ name: "gfm", order: 0 }] } as const;
  const cache = pageCache(cacheDir, options);
  const body = "Some *text*.\n";
  const key = await cache.key(body, 1);
  const file = join(cacheDir, `${key}.json`);
  try {
    mkdirSync(cacheDir, { recursive: true });

    assert.equal(await cache.get(key), undefined, "a missing entry misses");
    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, true);

    writeFileSync(file, "{ not json");
    assert.equal(await cache.get(key), undefined, "corrupt JSON misses");
    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, true);

    writeFileSync(
      file,
      JSON.stringify({ format: 0, engine: "1.0.0", key, tree: { type: "root", children: [] } }),
    );
    assert.equal(await cache.get(key), undefined, "an older format misses");
    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, true);

    writeFileSync(
      file,
      JSON.stringify({ format: PAGE_CACHE_FORMAT, engine: "0.0.0", key, tree: { type: "root", children: [] } }),
    );
    assert.equal(await cache.get(key), undefined, "an entry from another engine misses");
    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, true);

    writeFileSync(
      file,
      JSON.stringify({ format: PAGE_CACHE_FORMAT, engine: "1.0.0", key: "0".repeat(64), tree: { type: "root", children: [] } }),
    );
    assert.equal(await cache.get(key), undefined, "an entry under the wrong key misses");

    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, true);
    assert.equal((await parseMarkdownWithCache(body, 1, cache)).parsed, false, "a fresh entry hits");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("concurrent writes land atomically and leave no temporary files", async () => {
  const cacheDir = scratch();
  const cache = pageCache(cacheDir, { engineVersion: "1.0.0", plugins: [] });
  const bodies = Array.from({ length: 8 }, (_, index) => `# Page ${index}\n\nBody ${index}.\n`);
  try {
    await Promise.all(bodies.map((body) => parseMarkdownCached(body, 1, cache)));
    const names = entries(cacheDir);
    assert.equal(names.length, bodies.length);
    for (const body of bodies) {
      const key = await cache.key(body, 1);
      assert.ok(await cache.get(key), `entry ${key} is readable`);
      const stored = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8")) as { format: number };
      assert.equal(stored.format, PAGE_CACHE_FORMAT);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("build with cache stores page entries, and a whole-build miss reuses them", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache\n",
    "a.md": "---\ntitle: A\n---\n# A\n",
    "b.md": "---\ntitle: B\n---\n# B\n",
  });
  const cacheDir = scratch();
  const out = join(cacheDir, "site");
  const pages = join(cacheDir, "pages");
  try {
    const first = await build({ root, out, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(
      first.diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    const names = entries(pages);
    assert.equal(names.length, 2, "both pages are parsed and stored on a cold build");

    // Drop the whole-build entry but keep the page entries, so the next build must build the model; pin the page
    // entries' timestamps so a rewrite (a page-cache miss) would be visible.
    for (const dirent of readdirSync(cacheDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && /^[0-9a-f]{64}$/.test(dirent.name)) {
        rmSync(join(cacheDir, dirent.name), { recursive: true, force: true });
      }
    }
    const pinned = new Date(0);
    for (const name of names) utimesSync(join(pages, name), pinned, pinned);

    const second = await build({ root, out, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(
      second.diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    for (const name of names) {
      assert.equal(statSync(join(pages, name)).mtimeMs, 0, `${name} was read from the cache, not rewritten`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the page cache format is recorded with the engine version", async () => {
  const cacheDir = scratch();
  try {
    const cache = pageCache(cacheDir);
    const body = "# Hi\n";
    await parseMarkdownCached(body, 1, cache);
    const key = await cache.key(body, 1);
    const entry = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8")) as {
      format: number;
      engine: string;
      key: string;
    };
    assert.equal(entry.format, PAGE_CACHE_FORMAT);
    assert.equal(entry.engine, version);
    assert.equal(entry.key, key);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
