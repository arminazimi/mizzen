/**
 * Issue #106: the page-cache key and the entry contract include a deterministic fingerprint of the parser and the
 * built-in Markdown plugin modules, so a cached tree cannot outlive a change in the code that produces it — even
 * before the package version moves. An implementation input that cannot be read is a miss, never stale content.
 *
 * The cache's `implementation` and `implementationFiles` options are the test seam: the fingerprint these tests
 * exercise comes from files written into a temporary folder, so no repository source is edited here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseMarkdown } from "../src/markdown/parse.ts";
import {
  PAGE_CACHE_FORMAT,
  pageCache,
  parseMarkdownCached,
  parseMarkdownWithCache,
  type PageCacheMissReason,
} from "../src/pipeline/page-cache.ts";

/** Everything but the implementation, pinned so only the implementation bytes move in these tests. */
const ENGINE = { engineVersion: "1.0.0", plugins: [{ name: "gfm", order: 0 }] } as const;

const BODY = "# Cached\n\nSome *body* text.\n";

const PARSE_BYTES = 'export async function parseMarkdown(body, bodyLine = 1) { return { type: "root", children: [] } }\n';
const GFM_BYTES = 'export default { name: "gfm", order: 0, plugin() {} };\n';
const SLUG_BYTES = 'export default { name: "slug", order: 1, plugin() {} };\n';

/** A temporary folder holding `files`. */
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "page-cache-implementation-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The parser and built-in plugin modules of `root`. */
function implementationFiles(root: string): string[] {
  return [
    join(root, "markdown/parse.ts"),
    join(root, "markdown/plugins/gfm.ts"),
    join(root, "markdown/plugins/slug.ts"),
  ];
}

/** A temporary folder for a cache. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "page-cache-implementation-"));
}

/** The cache files under `dir`, sorted. Throws when a temporary file is left behind. */
function entries(dir: string): string[] {
  const names = readdirSync(dir).sort();
  for (const name of names) assert.match(name, /^[0-9a-f]{64}\.json$/, `unexpected cache file ${name}`);
  return names;
}

/** The entry stored under `key`. */
function readEntry(dir: string, key: string): { format: number; engine: string; implementation: string; checksum: string } {
  return JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as {
    format: number;
    engine: string;
    implementation: string;
    checksum: string;
  };
}

test("changed parser bytes make a new key and keep an existing entry from being returned", async () => {
  const impl = folder({
    "markdown/parse.ts": PARSE_BYTES,
    "markdown/plugins/gfm.ts": GFM_BYTES,
    "markdown/plugins/slug.ts": SLUG_BYTES,
  });
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const before = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    const key = await before.key(BODY, 1);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal((await parseMarkdownWithCache(BODY, 1, before)).parsed, true);
    assert.equal(entries(pages).length, 1);

    writeFileSync(join(impl, "markdown/parse.ts"), `${PARSE_BYTES}// a one-line behaviour change\n`);
    const after = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });

    assert.notEqual(await after.key(BODY, 1), key, "the parser's bytes are part of the key");

    const reasons: PageCacheMissReason[] = [];
    const reader = pageCache(pages, {
      ...ENGINE,
      implementationFiles: implementationFiles(impl),
      onMiss: (reason) => {
        reasons.push(reason);
      },
    });
    assert.equal(await reader.get(key), undefined, "the entry the old parser wrote is not returned");
    assert.deepEqual(reasons, ["incompatible"]);

    const replaced = await parseMarkdownWithCache(BODY, 1, after);
    assert.equal(replaced.parsed, true, "a cold parse replaces the entry");
    assert.deepEqual(replaced.tree, await parseMarkdown(BODY, 1));
    assert.equal(entries(pages).length, 2, "the stale entry and the replacement both sit on disk");
    assert.equal((await parseMarkdownWithCache(BODY, 1, after)).parsed, false, "the replacement is reusable");
  } finally {
    rmSync(impl, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("changed plugin bytes make a new key too, wherever the plugin sits in the order", async () => {
  const impl = folder({
    "markdown/parse.ts": PARSE_BYTES,
    "markdown/plugins/gfm.ts": GFM_BYTES,
    "markdown/plugins/slug.ts": SLUG_BYTES,
  });
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const before = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    const key = await before.key(BODY, 1);
    assert.equal((await parseMarkdownWithCache(BODY, 1, before)).parsed, true);

    writeFileSync(join(impl, "markdown/plugins/slug.ts"), `${SLUG_BYTES}// last plugin, changed\n`);
    const lastChanged = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    const slugKey = await lastChanged.key(BODY, 1);
    assert.notEqual(slugKey, key, "a change to the last plugin is a new key");

    writeFileSync(join(impl, "markdown/plugins/gfm.ts"), `${GFM_BYTES}// first plugin, changed\n`);
    const firstChanged = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    assert.notEqual(await firstChanged.key(BODY, 1), slugKey, "and so is a change to the first");
  } finally {
    rmSync(impl, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("unchanged implementation bytes and content keep a stable key and reuse the cached tree", async () => {
  const impl = folder({
    "markdown/parse.ts": PARSE_BYTES,
    "markdown/plugins/gfm.ts": GFM_BYTES,
    "markdown/plugins/slug.ts": SLUG_BYTES,
  });
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const first = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    const key = await first.key(BODY, 1);
    assert.equal((await parseMarkdownWithCache(BODY, 1, first)).parsed, true);

    // The same files, listed in another order, and a fresh instance: the key must not move.
    const reversed = [...implementationFiles(impl)].reverse();
    const second = pageCache(pages, { ...ENGINE, implementationFiles: reversed });
    assert.equal(await second.key(BODY, 1), key, "the read order of the implementation inputs is not part of the key");
    assert.equal(await second.key(BODY, 1), await second.key(BODY, 1), "the key is stable across calls");
    assert.equal((await parseMarkdownWithCache(BODY, 1, second)).parsed, false, "the cached tree is reused");
    assert.equal(entries(pages).length, 1, "the entry is written once");

    // A byte-for-byte copy of one implementation module, rewritten, is the same implementation.
    writeFileSync(join(impl, "markdown/plugins/gfm.ts"), GFM_BYTES);
    const third = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    assert.equal(await third.key(BODY, 1), key);
    assert.equal((await parseMarkdownWithCache(BODY, 1, third)).parsed, false);

    // A file the implementation does not include changes nothing.
    writeFileSync(join(impl, "markdown/plugins/README.md"), "notes, not a module\n");
    const fourth = pageCache(pages, { ...ENGINE, implementationFiles: implementationFiles(impl) });
    assert.equal(await fourth.key(BODY, 1), key);
    assert.equal((await parseMarkdownWithCache(BODY, 1, fourth)).parsed, false);
  } finally {
    rmSync(impl, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an unreadable implementation input is a miss, and nothing unprovable is written", async () => {
  const impl = folder({
    "markdown/parse.ts": PARSE_BYTES,
    "markdown/plugins/gfm.ts": GFM_BYTES,
    "markdown/plugins/slug.ts": SLUG_BYTES,
  });
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const readable = implementationFiles(impl);
    const good = pageCache(pages, { ...ENGINE, implementationFiles: readable });
    const key = await good.key(BODY, 1);
    assert.equal((await parseMarkdownWithCache(BODY, 1, good)).parsed, true);

    // One implementation module cannot be read: the entry written while it could be is not trusted.
    const unreadable = [...readable, join(impl, "markdown/plugins/deleted.ts")];
    const reasons: PageCacheMissReason[] = [];
    const blind = pageCache(pages, {
      ...ENGINE,
      implementationFiles: unreadable,
      onMiss: (reason) => {
        reasons.push(reason);
      },
    });
    assert.match(await blind.key(BODY, 1), /^[0-9a-f]{64}$/, "a key is still a key");
    assert.equal(await blind.get(key), undefined, "an entry this run cannot describe is a miss");
    assert.deepEqual(reasons, ["incompatible"]);

    const cold = await parseMarkdown(BODY, 1);
    const result = await parseMarkdownWithCache(BODY, 1, blind);
    assert.equal(result.parsed, true, "the page is parsed again");
    assert.deepEqual(result.tree, cold, "and the tree is exactly a cold parse's");
    assert.equal(entries(pages).length, 1, "no entry is written for an implementation the cache cannot fingerprint");

    // An implementation input that is there but unreadable as a file behaves the same way.
    const blocked = join(impl, "markdown/plugins/blocked.ts");
    mkdirSync(blocked);
    const alsoBlind = pageCache(pages, {
      ...ENGINE,
      implementationFiles: [...readable.slice(0, 2), blocked, readable[2]!],
    });
    assert.equal((await parseMarkdownWithCache(BODY, 1, alsoBlind)).parsed, true);
    assert.equal(entries(pages).length, 1, "still nothing written");
  } finally {
    rmSync(impl, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("corrupt, incompatible, and half-written entries stay misses, and a cold parse replaces them", async () => {
  const impl = folder({
    "markdown/parse.ts": PARSE_BYTES,
    "markdown/plugins/gfm.ts": GFM_BYTES,
    "markdown/plugins/slug.ts": SLUG_BYTES,
  });
  const cacheDir = scratch();
  const reasons: PageCacheMissReason[] = [];
  const cache = pageCache(cacheDir, {
    ...ENGINE,
    implementationFiles: implementationFiles(impl),
    onMiss: (reason) => {
      reasons.push(reason);
    },
  });
  const key = await cache.key(BODY, 1);
  const file = join(cacheDir, `${key}.json`);
  try {
    assert.equal((await parseMarkdownCached(BODY, 1, cache)).type, "root");
    const implementation = readEntry(cacheDir, key).implementation;
    assert.match(implementation, /^[0-9a-f]{64}$/, "the entry records the implementation it was parsed by");
    assert.equal(readEntry(cacheDir, key).format, PAGE_CACHE_FORMAT);

    reasons.length = 0;
    writeFileSync(file, '{"format":');
    assert.equal(await cache.get(key), undefined, "truncated bytes miss");
    assert.deepEqual(reasons, ["corrupt"]);

    reasons.length = 0;
    writeFileSync(
      file,
      JSON.stringify({
        format: PAGE_CACHE_FORMAT,
        engine: "1.0.0",
        key,
        implementation: "0".repeat(64),
        checksum: "0".repeat(64),
        tree: { type: "root", children: [] },
      }),
    );
    assert.equal(await cache.get(key), undefined, "an entry written by other implementation code misses");
    assert.deepEqual(reasons, ["incompatible"]);

    reasons.length = 0;
    writeFileSync(
      file,
      JSON.stringify({ format: PAGE_CACHE_FORMAT - 1, engine: "1.0.0", key, tree: { type: "root", children: [] } }),
    );
    assert.equal(await cache.get(key), undefined, "an entry of the previous format misses");
    assert.deepEqual(reasons, ["incompatible"]);

    reasons.length = 0;
    assert.equal((await parseMarkdownWithCache(BODY, 1, cache)).parsed, true, "a cold parse replaces the entry");
    assert.deepEqual(reasons, ["incompatible"]);
    const replacement = readEntry(cacheDir, key);
    assert.equal(replacement.implementation, implementation, "the replacement records the same implementation");
    assert.match(replacement.checksum, /^[0-9a-f]{64}$/);

    reasons.length = 0;
    assert.equal((await parseMarkdownWithCache(BODY, 1, cache)).parsed, false, "the replacement is then reused");
    assert.deepEqual(reasons, []);

    // A tree edited inside a well-formed entry is caught by its checksum, not read.
    const stored = JSON.parse(readFileSync(file, "utf8")) as { tree: { children: unknown[] } };
    stored.tree.children.push({ type: "text", value: "injected" });
    writeFileSync(file, JSON.stringify(stored));
    reasons.length = 0;
    assert.equal(await cache.get(key), undefined, "a tampered tree misses");
    assert.deepEqual(reasons, ["corrupt"]);

    // A leftover temporary write is never read as an entry, and does not stop the entry from hitting.
    mkdirSync(join(cacheDir, ".tmp-left-over"));
    writeFileSync(join(cacheDir, ".tmp-left-over", "entry.json"), '{"format":99}');
    assert.equal((await parseMarkdownWithCache(BODY, 1, cache)).parsed, true, "the tampered entry is replaced");
    assert.ok(await cache.get(key));
    rmSync(join(cacheDir, ".tmp-left-over"), { recursive: true, force: true });
    assert.deepEqual(entries(cacheDir), [`${key}.json`], "the cache folder holds the entry alone");
  } finally {
    rmSync(impl, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an explicit implementation override is the whole difference between two keys", async () => {
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const firstFingerprint = "a".repeat(64);
    const before = pageCache(pages, { ...ENGINE, implementation: firstFingerprint });
    const key = await before.key(BODY, 1);
    assert.equal((await parseMarkdownWithCache(BODY, 1, before)).parsed, true);

    const equal = pageCache(pages, { ...ENGINE, implementation: firstFingerprint });
    assert.equal(await equal.key(BODY, 1), key, "an equal override gives an equal key");
    assert.equal((await parseMarkdownWithCache(BODY, 1, equal)).parsed, false, "and the entry is reused");

    const changed = pageCache(pages, { ...ENGINE, implementation: "b".repeat(64) });
    assert.notEqual(await changed.key(BODY, 1), key, "a changed override gives a new key");
    assert.equal((await parseMarkdownWithCache(BODY, 1, changed)).parsed, true);

    // The override and the file list agree: the same bytes, read or named, are the same implementation.
    const impl = folder({
      "markdown/parse.ts": PARSE_BYTES,
      "markdown/plugins/gfm.ts": GFM_BYTES,
    });
    try {
      const files = [join(impl, "markdown/parse.ts"), join(impl, "markdown/plugins/gfm.ts")];
      const fromFiles = pageCache(pages, { ...ENGINE, implementationFiles: files });
      const again = pageCache(pages, { ...ENGINE, implementationFiles: [...files].reverse() });
      assert.equal(await fromFiles.key(BODY, 1), await again.key(BODY, 1));
    } finally {
      rmSync(impl, { recursive: true, force: true });
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the default key fingerprints this engine's parser and built-in plugin modules", async () => {
  const cacheDir = scratch();
  const pages = join(cacheDir, "pages");
  try {
    const auto = pageCache(pages);
    const key = await auto.key(BODY, 1);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(key, await pageCache(pages).key(BODY, 1), "the default key is stable across instances");
    assert.equal((await parseMarkdownWithCache(BODY, 1, auto)).parsed, true);
    assert.equal((await parseMarkdownWithCache(BODY, 1, pageCache(pages))).parsed, false, "and its entry is reusable");

    const entry = readEntry(pages, key);
    assert.match(entry.implementation, /^[0-9a-f]{64}$/, "a real digest, not a placeholder");
    assert.notEqual(entry.implementation, "0".repeat(64));

    // A different implementation fingerprint is a different key, and an unusable one is a miss.
    assert.notEqual(await pageCache(pages, { implementation: entry.implementation.slice(1) + "0" }).key(BODY, 1), key);
    const overriden = pageCache(pages, { implementation: entry.implementation });
    assert.equal(await overriden.key(BODY, 1), key, "the override names exactly what the default computes");
    assert.equal((await parseMarkdownWithCache(BODY, 1, overriden)).parsed, false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
