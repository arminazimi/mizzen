/**
 * Issue #146: a page-cache entry is bounded before it is parsed. An entry over the documented limit is a corrupt
 * miss — never fully buffered, decoded, or handed to `JSON.parse` — and its page is parsed afresh and stored again.
 * An entry of exactly the limit is still read normally.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_ENTRY_BYTES,
  pageCache,
  parseMarkdownCached,
  parseMarkdownWithCache,
  type PageCacheMissReason,
} from "../src/pipeline/page-cache.ts";

/** Everything but the implementation, pinned so these tests never read the engine's own files. */
const OPTIONS = { engineVersion: "1.0.0", plugins: [] } as const;

/** A body whose entry is small and ASCII, so padding it to a byte boundary is exact. */
const BODY = "# Bounded\n\nSome *text*.\n";

/** A temporary folder for a cache, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "page-cache-limits-"));
}

test("an entry over the limit is a corrupt miss, and the page is parsed and stored again", async () => {
  const cacheDir = scratch();
  const reasons: PageCacheMissReason[] = [];
  const cache = pageCache(cacheDir, {
    ...OPTIONS,
    onMiss: (reason) => {
      reasons.push(reason);
    },
  });
  try {
    const cold = await parseMarkdownCached(BODY, 1, cache);
    const key = await cache.key(BODY, 1);
    const file = join(cacheDir, `${key}.json`);
    const stored = readFileSync(file, "utf8");

    // A good entry padded past the limit with trailing whitespace: reading it whole would parse and hit.
    const oversized = stored + " ".repeat(MAX_ENTRY_BYTES + 1 - Buffer.byteLength(stored));
    writeFileSync(file, oversized);
    assert.deepEqual(JSON.parse(oversized), JSON.parse(stored), "only the bound can reject this entry");

    reasons.length = 0;
    assert.equal(await cache.get(key), undefined, "an entry over the limit is a miss");
    assert.deepEqual(reasons, ["corrupt"], "and a corrupt one, never a throw or a partial tree");

    reasons.length = 0;
    const rescued = await parseMarkdownWithCache(BODY, 1, cache);
    assert.deepEqual(reasons, ["corrupt"], "the oversized entry is reported, then the page is parsed afresh");
    assert.equal(rescued.parsed, true);
    assert.deepEqual(rescued.tree, cold, "the fresh tree is the cold tree");
    assert.equal((await parseMarkdownWithCache(BODY, 1, cache)).parsed, false, "the replacement entry hits");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an entry exactly at the limit is read normally", async () => {
  const cacheDir = scratch();
  const reasons: PageCacheMissReason[] = [];
  const cache = pageCache(cacheDir, {
    ...OPTIONS,
    onMiss: (reason) => {
      reasons.push(reason);
    },
  });
  try {
    const cold = await parseMarkdownCached(BODY, 1, cache);
    const key = await cache.key(BODY, 1);
    const file = join(cacheDir, `${key}.json`);
    const stored = readFileSync(file, "utf8");

    const atLimit = stored + " ".repeat(MAX_ENTRY_BYTES - Buffer.byteLength(stored));
    assert.equal(Buffer.byteLength(atLimit), MAX_ENTRY_BYTES);
    writeFileSync(file, atLimit);

    reasons.length = 0;
    assert.deepEqual(await cache.get(key), cold, "an entry of exactly the limit is a hit");
    assert.deepEqual(reasons, []);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a failed read is a corrupt miss and does not stop the fresh parse", async () => {
  const cacheDir = scratch();
  const reasons: PageCacheMissReason[] = [];
  const cache = pageCache(cacheDir, {
    ...OPTIONS,
    onMiss: (reason) => {
      reasons.push(reason);
    },
  });
  try {
    const cold = await parseMarkdownCached(BODY, 1, cache);
    const key = await cache.key(BODY, 1);
    const file = join(cacheDir, `${key}.json`);

    // A folder where the entry file should be: opening it succeeds, reading it fails.
    rmSync(file);
    mkdirSync(file);

    reasons.length = 0;
    assert.equal(await cache.get(key), undefined, "an unreadable entry is a miss");
    assert.deepEqual(reasons, ["corrupt"]);
    const rescued = await parseMarkdownWithCache(BODY, 1, cache);
    assert.equal(rescued.parsed, true, "a failed read still lets the page be parsed");
    assert.deepEqual(rescued.tree, cold);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
