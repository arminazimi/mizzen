import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  cachedRun,
  defaultExampleRuntime,
  exampleCache,
  exampleCacheDirOf,
  exampleCacheKey,
  type ExampleKeyInput,
} from "../src/pipeline/examples/cache.ts";

/** A runner result shaped like the Node example runner's. */
interface FakeResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly durationMs?: number;
}

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "example-cache-"));
}

/** One example, unchanged between calls. */
const EXAMPLE: ExampleKeyInput = { code: 'console.log("hi");\n', lang: "js", kind: "node" };

test("the same example runs once across two caches in the same folder", async () => {
  const dir = scratch();
  try {
    const input = EXAMPLE;
    let runs = 0;
    const runner = async (): Promise<FakeResult> => {
      runs++;
      return { ok: true, stdout: "hi\n", durationMs: 12 };
    };

    const first = await cachedRun(exampleCache({ dir }), input, runner);
    const second = await cachedRun(exampleCache({ dir }), input, runner);

    assert.equal(runs, 1, "the second call read the result instead of running the example");
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.result.stdout, "hi\n");
    assert.equal(second.result.durationMs, 0, "a hit reports no elapsed time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed code, language, kind, or runtime invalidates the entry", async () => {
  const dir = scratch();
  try {
    let runs = 0;
    const run = (input: ExampleKeyInput, runtime?: string): Promise<{ cached: boolean }> =>
      cachedRun(exampleCache(runtime === undefined ? { dir } : { dir, runtime }), input, async () => {
        runs++;
        return { ok: true, stdout: "hi\n", durationMs: 1 };
      });

    assert.equal((await run(EXAMPLE)).cached, false);
    assert.equal((await run(EXAMPLE)).cached, true);
    assert.equal((await run({ ...EXAMPLE, code: 'console.log("bye");\n' })).cached, false);
    assert.equal((await run({ ...EXAMPLE, lang: "ts" })).cached, false);
    assert.equal((await run({ ...EXAMPLE, kind: "shell" })).cached, false);
    assert.equal((await run(EXAMPLE, "v99.0.0 mizzen-test")).cached, false);
    assert.equal(runs, 5, "every changed input ran the example once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt, truncated, or foreign entry is a miss, never a throw", async () => {
  const dir = scratch();
  try {
    const cache = exampleCache({ dir });
    const key = cache.key(EXAMPLE);

    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}.json`);

    for (const body of ["not json\n", '{"format":1,"key":"' + key + '"}', '{"format":99,"key":"' + key + '","result":{}}']) {
      writeFileSync(file, body);
      assert.equal(await cache.get(key), undefined, `"${body.trim()}" was a miss`);
    }

    // A cached miss is not filled in, but the next run is.
    let runs = 0;
    const result = await cachedRun(cache, EXAMPLE, async () => {
      runs++;
      return { ok: true, stdout: "hi\n", durationMs: 3 };
    });
    assert.equal(runs, 1);
    assert.equal(result.cached, false);
    assert.equal(await cache.get("not-a-key"), undefined, "an invalid key is a miss");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry is written atomically and leaves no temporary file", async () => {
  const dir = scratch();
  try {
    const cache = exampleCache({ dir });
    const key = cache.key(EXAMPLE);
    await cache.set(key, { ok: true, stdout: "hi\n", durationMs: 5 });

    const names = readdirSync(dir).sort();
    assert.deepEqual(names, [`${key}.json`], "only the entry file remains");
    assert.ok(names.every((name) => !name.startsWith(".tmp-")), "the temporary folder was removed");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")), {
      format: 1,
      key,
      result: { ok: true, stdout: "hi\n" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same result always produces the same bytes, without a timing field", async () => {
  const dir = scratch();
  try {
    const cache = exampleCache({ dir });
    const key = cache.key(EXAMPLE);
    await cache.set(key, { ok: true, stdout: "hi\n", durationMs: 5 });
    const first = readFileSync(join(dir, `${key}.json`), "utf8");

    await cache.set(key, { ok: true, stdout: "hi\n", durationMs: 1234 });
    const second = readFileSync(join(dir, `${key}.json`), "utf8");

    assert.equal(second, first, "a different duration does not change the stored bytes");
    assert.equal(first.includes("durationMs"), false, "no wall-clock field is stored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key is deterministic and covers every input", () => {
  const key = exampleCacheKey(EXAMPLE, "v1");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(exampleCacheKey({ ...EXAMPLE }, "v1"), key, "the same input hashes the same");
  assert.equal(exampleCacheKey({ ...EXAMPLE, code: "x" }, "v1") === key, false);
  assert.equal(exampleCacheKey({ ...EXAMPLE, lang: "ts" }, "v1") === key, false);
  assert.equal(exampleCacheKey({ ...EXAMPLE, kind: "shell" }, "v1") === key, false);
  assert.equal(exampleCacheKey(EXAMPLE, "v2") === key, false);
  assert.equal(exampleCacheKey(EXAMPLE), exampleCacheKey(EXAMPLE, defaultExampleRuntime()));
});

test("a custom folder is used, created on demand, and a non-object result is not stored", async () => {
  const parent = scratch();
  const dir = join(parent, "nested", "examples");
  try {
    const cache = exampleCache({ dir });
    assert.equal(cache.dir, resolve(dir));
    assert.equal(existsSync(dir), false, "opening a cache creates nothing");

    await cache.set(cache.key(EXAMPLE), { ok: true });
    assert.equal(existsSync(join(dir, `${cache.key(EXAMPLE)}.json`)), true);

    const other = join(parent, "other");
    const otherCache = exampleCache({ dir: other });
    await otherCache.set(otherCache.key(EXAMPLE), "not an object");
    assert.equal(existsSync(other), false, "a non-object result is not stored");
    assert.equal(await otherCache.get(otherCache.key(EXAMPLE)), undefined);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("without a folder the cache lives under the site root and is safe to delete", async () => {
  const root = scratch();
  try {
    assert.equal(exampleCacheDirOf(root), join(resolve(root), ".slipway", "examples"));
    const cache = exampleCache({ root });
    const key = cache.key(EXAMPLE);
    assert.equal(cache.dir, exampleCacheDirOf(root));

    await cache.set(key, { ok: true, stdout: "hi\n" });
    assert.equal(existsSync(join(root, ".slipway", "examples", `${key}.json`)), true);

    rmSync(cache.dir, { recursive: true, force: true });
    assert.equal(await cache.get(key), undefined, "a deleted cache is a miss");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
