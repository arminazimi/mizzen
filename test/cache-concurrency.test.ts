/**
 * Concurrency and failure proof for the whole-build cache: readers never see an entry missing or half replaced while
 * another build writes the same key, a burst of different-key builds keeps a bounded set of complete entries, and
 * corrupt, interrupted, stale, or unreadable cache state always costs a cold build rather than wrong bytes or a hang.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/contracts/index.ts";
import { build } from "../src/pipeline/build.ts";
import { CACHE_RETENTION, restoreCache, writeCache, type CacheMissReason } from "../src/pipeline/cache.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CACHE_URL = new URL("../src/pipeline/cache.ts", import.meta.url).href;
const KEY = /^[0-9a-f]{64}$/;

/** A temporary folder holding `files`, uniquely named for this issue. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cache-concurrency-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary parent for the output and the cache. */
function scratch(): { parent: string; out: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "cache-concurrency-"));
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

/** The cache entry folders: the ones named after a key. */
function entries(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && KEY.test(entry.name))
    .map((entry) => join(cacheDir, entry.name));
}

/**
 * A child process that drives the cache lock primitives on one request at a time, so two breakers can
 * be interleaved deterministically instead of racing on the scheduler.
 */
function lockChild(cacheRoot: string): { send(command: string): Promise<string>; close(): void } {
  const script = `
const { createInterface } = require("node:readline");
(async () => {
  const { cacheLockInternals } = await import(${JSON.stringify(CACHE_URL)});
  const [cacheRoot] = process.argv.slice(1);
  const lock = cacheRoot + "/" + ".lock";
  let held;
  for await (const line of createInterface({ input: process.stdin })) {
    const space = line.indexOf(" ");
    const command = space === -1 ? line : line.slice(0, space);
    const argument = space === -1 ? undefined : line.slice(space + 1);
    try {
      if (command === "probe") console.log(JSON.stringify(await cacheLockInternals.probeAbandonedLock(lock)));
      else if (command === "break") {
        console.log(JSON.stringify(await cacheLockInternals.breakAbandonedLock(lock, JSON.parse(argument))));
      } else if (command === "lock") {
        held = await cacheLockInternals.lockCache(cacheRoot);
        console.log(JSON.stringify(held));
      } else if (command === "unlock") {
        await cacheLockInternals.unlockCache(cacheRoot, JSON.parse(argument));
        console.log("null");
      } else if (command === "stop") break;
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  process.exit(0);
})();
`;

  const child = spawn(process.execPath, ["-e", script, cacheRoot], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next(line);
  });

  return {
    async send(command: string): Promise<string> {
      child.stdin.write(`${command}\n`);
      const line = lines.length > 0 ? lines.shift()! : await new Promise<string>((next) => waiting.push(next));
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && "error" in value) {
        throw new Error((value as { error: string }).error);
      }
      return line;
    },
    close(): void {
      child.kill();
    },
  };
}

/** Every temporary or lock name in the cache root; the `pages` folder of the per-page cache is not one. */
function leftovers(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter(
    (name) => name === ".lock" || name.startsWith(".tmp-") || name.startsWith(".old-"),
  );
}

/** A minimal theme layout; it renders the page into the output so two builds can be compared. */
function layoutSource(): string {
  return `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) =>
  h(
    "html",
    null,
    h(
      "body",
      null,
      h("pre", { id: "title" }, props.site.config.title),
      h("div", { dangerouslySetInnerHTML: { __html: props.page.html } }),
    ),
  );

export default doc;
`;
}

/** A temporary theme that renders pages with `layoutSource`. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "cache-concurrency-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "cache-concurrency", folders: ["layouts"] };\n');
  writeFileSync(join(root, "layouts/doc.ts"), layoutSource());
  return root;
}

/** A finished output folder, its key, and the diagnostics an entry records. */
interface Variant {
  readonly html: string;
  readonly js: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** A source folder that produces `variant`. */
function sourceOf(variant: Variant): string {
  return tree({ "index.html": variant.html, "assets/app.js": variant.js });
}

/** One of two complete entries that can wear the same key, so a replacement is visible in restored bytes. */
function variantOf(name: "A" | "B"): Variant {
  const marker = name === "A" ? "A" : "B";
  return {
    html: `<h1>${marker}</h1>\n`,
    js: marker.repeat(100_000),
    diagnostics: [{ id: `test.${name.toLowerCase()}`, severity: "warning", message: `${name}.` }],
  };
}

/** The files every variant writes. */
const FILES = ["assets/app.js", "index.html"];

test("parallel readers never miss or see a partial entry while one key is replaced", async () => {
  const { parent, cacheDir } = scratch();
  const key = "c".repeat(64);
  const a = variantOf("A");
  const b = variantOf("B");
  const sourceA = sourceOf(a);
  const sourceB = sourceOf(b);
  const out = join(parent, "out");
  try {
    await writeCache(cacheDir, key, sourceA, FILES, a.diagnostics);

    const misses: CacheMissReason[] = [];
    let writing = true;
    const reader = async (): Promise<void> => {
      while (writing) {
        const hit = await restoreCache(cacheDir, key, out, { onMiss: (reason) => misses.push(reason) });
        assert.ok(hit !== undefined, `a reader never observes the entry missing during replacement (${misses.join(",")})`);
        try {
          assert.deepEqual(hit.files, FILES);
          const html = readFileSync(join(hit.staging, "index.html"), "utf8");
          const js = readFileSync(join(hit.staging, "assets/app.js"), "utf8");
          const expected = html === a.html ? a : html === b.html ? b : undefined;
          assert.ok(expected !== undefined, "a reader sees one whole entry, never a blend");
          assert.equal(js, expected.js, "every file belongs to the same entry");
          assert.deepEqual(hit.diagnostics, expected.diagnostics, "the manifest and its diagnostics move together");
        } finally {
          rmSync(hit.staging, { recursive: true, force: true });
        }
      }
    };

    const readers = Array.from({ length: 3 }, () => reader());
    for (let round = 0; round < 12; round++) {
      const next = round % 2 === 0 ? { source: sourceB, variant: b } : { source: sourceA, variant: a };
      await writeCache(cacheDir, key, next.source, FILES, next.variant.diagnostics);
    }
    writing = false;
    await Promise.all(readers);

    assert.deepEqual(misses, [], "no reader falls back to a cold build");
    assert.deepEqual(leftovers(cacheDir), [], "no lock, staging, or backup folder is left behind");
    assert.equal(entries(cacheDir).length, 1, "the cache still holds the one entry");
  } finally {
    rmSync(sourceA, { recursive: true, force: true });
    rmSync(sourceB, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("two breakers that both saw an abandoned lock cannot remove the replacement", async () => {
  const { cacheDir } = scratch();
  mkdirSync(cacheDir, { recursive: true });
  try {
    const lock = join(cacheDir, ".lock");
    // A writer that is gone, so this lock is abandoned state on its owner and not on its age (#109).
    const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = corpse.pid;
    assert.ok(deadPid !== undefined, "the crashed writer has a PID");
    await new Promise<void>((done) => corpse.once("close", () => done()));
    await new Promise<void>((done) => setTimeout(done, 50));
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${deadPid}\nold\n`);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(lock, past, past);

    const first = lockChild(cacheDir);
    const second = lockChild(cacheDir);
    try {
      // Both breakers inspect the abandoned lock before either may remove it.
      const firstProbe = JSON.parse(await first.send("probe")) as { ino: number; abandoned: boolean };
      const secondProbe = JSON.parse(await second.send("probe")) as { ino: number; abandoned: boolean };
      assert.equal(firstProbe.abandoned, true);
      assert.equal(secondProbe.abandoned, true);
      assert.equal(firstProbe.ino, secondProbe.ino, "both saw the same lock inode");

      assert.equal(await first.send(`break ${JSON.stringify(firstProbe)}`), "true");
      const held = JSON.parse(await first.send("lock")) as { token: string };
      assert.ok(held.token, "the first breaker took a replacement lock");
      assert.match(readFileSync(join(lock, "owner"), "utf8"), new RegExp(held.token));

      assert.equal(
        await second.send(`break ${JSON.stringify(secondProbe)}`),
        "false",
        "the second breaker must not claim the abandoned lock after its replacement exists",
      );
      assert.match(
        readFileSync(join(lock, "owner"), "utf8"),
        new RegExp(held.token),
        "the second breaker left the replacement lock alone",
      );
      assert.equal(existsSync(`${lock}.recover`), false, "no breaker guard is left behind");

      await first.send(`unlock ${JSON.stringify(held.token)}`);
      assert.equal(existsSync(lock), false, "the first breaker released its own lock");
    } finally {
      first.close();
      second.close();
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("parallel different-key builds keep a bounded set of complete entries", async () => {
  const { parent, cacheDir } = scratch();
  const out = join(parent, "out");
  const count = CACHE_RETENTION + 3;
  const keys = Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, "0"));
  const sources = keys.map((_, index) =>
    sourceOf({
      html: `<h1>page ${index}</h1>\n`,
      js: `console.log(${index});\n`,
      diagnostics: [{ id: `test.${index}`, severity: "warning", message: `Page ${index}.` }],
    }),
  );
  try {
    await Promise.all(
      keys.map((key, index) =>
        writeCache(cacheDir, key, sources[index]!, FILES, [
          { id: `test.${index}`, severity: "warning", message: `Page ${index}.` },
        ]),
      ),
    );

    const present = entries(cacheDir);
    assert.equal(present.length, CACHE_RETENTION, "the documented bound is retained, not every key ever seen");
    assert.deepEqual(leftovers(cacheDir), [], "concurrent writers leave no lock, staging, or backup folder");

    for (const dir of present) {
      const key = basename(dir);
      const index = keys.indexOf(key);
      assert.ok(index >= 0, "only whole entries remain");
      const hit = await restoreCache(cacheDir, key, out);
      assert.ok(hit !== undefined, `entry ${index} is still complete`);
      assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), `<h1>page ${index}</h1>\n`);
      assert.equal(readFileSync(join(hit.staging, "assets/app.js"), "utf8"), `console.log(${index});\n`);
      assert.deepEqual(hit.diagnostics, [{ id: `test.${index}`, severity: "warning", message: `Page ${index}.` }]);
      rmSync(hit.staging, { recursive: true, force: true });
    }
  } finally {
    for (const source of sources) rmSync(source, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale locks and interrupted staging are cleaned and never turn corruption into a hit", async () => {
  const { parent, out, cacheDir } = scratch();
  const key = "d".repeat(64);
  const variant = variantOf("A");
  const source = sourceOf(variant);
  const reasons: CacheMissReason[] = [];
  const onMiss = (reason: CacheMissReason): void => {
    reasons.push(reason);
  };
  try {
    await writeCache(cacheDir, key, source, FILES, variant.diagnostics);

    // A writer died after staging its output and taking the lock: both are abandoned state.
    mkdirSync(join(cacheDir, ".tmp-abandoned", "out"), { recursive: true });
    writeFileSync(join(cacheDir, ".tmp-abandoned", "out", "index.html"), "<h1>partial</h1>\n");
    mkdirSync(join(cacheDir, `.old-${key}-gone`), { recursive: true });
    const lock = join(cacheDir, ".lock");
    mkdirSync(lock);
    const ancient = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, ancient, ancient);

    const hit = await restoreCache(cacheDir, key, out, { onMiss });
    assert.ok(hit !== undefined, "a stale lock is broken rather than hanging the build");
    assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), variant.html);
    assert.deepEqual(hit.diagnostics, variant.diagnostics);
    rmSync(hit.staging, { recursive: true, force: true });
    assert.deepEqual(leftovers(cacheDir), [], "stale lock and staging are cleaned by the next operation");

    // A half-written manifest is a miss and leaves nothing behind that a later read could trust.
    const [entry] = entries(cacheDir);
    assert.ok(entry !== undefined, "the write left one entry");
    writeFileSync(join(entry, "manifest.json"), "{ not json");
    mkdirSync(join(cacheDir, ".tmp-interrupted"), { recursive: true });
    reasons.length = 0;
    assert.equal(await restoreCache(cacheDir, key, out, { onMiss }), undefined);
    assert.deepEqual(reasons, ["corrupt"], "a corrupt manifest is a cold build, not a hit");
    assert.deepEqual(leftovers(cacheDir), [], "interrupted staging is cleaned even on a miss");
    assert.equal(existsSync(out), false, "a miss writes no output");

    // A repaired entry is usable again, and a failed replacement never loses the previous entry.
    await writeCache(cacheDir, key, source, FILES, variant.diagnostics);
    const again = await restoreCache(cacheDir, key, out);
    assert.deepEqual(again?.files, FILES);
    if (again !== undefined) rmSync(again.staging, { recursive: true, force: true });

    // A missing cache is a miss and is not created just by looking.
    const absent = join(parent, "never-created");
    reasons.length = 0;
    assert.equal(await restoreCache(absent, key, out, { onMiss }), undefined);
    assert.deepEqual(reasons, ["missing"]);
    assert.equal(existsSync(absent), false, "a read-only miss creates no cache folder");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("unreadable or unwritable cache state produces a cold build instead of throwing", async () => {
  const { parent, out, cacheDir } = scratch();
  const key = "e".repeat(64);
  const variant = variantOf("B");
  const source = sourceOf(variant);
  const reasons: CacheMissReason[] = [];
  try {
    // A cache path that is not a folder: both the lock and the write fail, and both are swallowed.
    writeFileSync(cacheDir, "not a folder\n");
    assert.equal(await restoreCache(cacheDir, key, out, { onMiss: (reason) => reasons.push(reason) }), undefined);
    assert.deepEqual(reasons, ["corrupt"]);
    await writeCache(cacheDir, key, source, FILES, variant.diagnostics);
    assert.equal(readFileSync(cacheDir, "utf8"), "not a folder\n", "a failed write leaves the path alone");
    rmSync(cacheDir, { force: true });

    // A cache the process may not write to: a restore falls back to cold, and the entry survives untouched.
    await writeCache(cacheDir, key, source, FILES, variant.diagnostics);
    if (process.getuid?.() !== 0) {
      chmodSync(cacheDir, 0o500);
      try {
        reasons.length = 0;
        assert.equal(await restoreCache(cacheDir, key, out, { onMiss: (reason) => reasons.push(reason) }), undefined);
        assert.deepEqual(reasons, ["corrupt"]);
        assert.equal(existsSync(out), false);
      } finally {
        chmodSync(cacheDir, 0o700);
      }

      const hit = await restoreCache(cacheDir, key, out);
      assert.ok(hit !== undefined, "permissions restored, the whole entry is still readable");
      assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), variant.html);
      rmSync(hit.staging, { recursive: true, force: true });
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a cold rebuild after corrupted or interrupted cache state matches a cache-less build byte for byte", async () => {
  const root = tree({
    "mizzen.yml": "title: Cache concurrency\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "guide/a.md": "---\ntitle: A\n---\n# A\n",
  });
  const theme = makeTheme();
  const { parent, out, cacheDir } = scratch();
  try {
    const first = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const cold = snapshot(out);

    // Rewrite the site without the cache, so the "identical bytes" comparison is against a genuine cold build.
    const plainOut = join(parent, "plain");
    const plain = await build({ root, out: plainOut, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(plainOut), cold, "the cached and cold outputs start identical");

    // Abandoned staging, a stale lock, and a corrupt manifest all at once.
    mkdirSync(join(cacheDir, ".tmp-abandoned", "out"), { recursive: true });
    writeFileSync(join(cacheDir, ".tmp-abandoned", "out", "index.html"), "partial\n");
    const lock = join(cacheDir, ".lock");
    mkdirSync(lock);
    const ancient = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, ancient, ancient);
    const [entry] = entries(cacheDir);
    assert.ok(entry !== undefined, "the first build wrote an entry");
    writeFileSync(join(entry, "manifest.json"), "{ not json");

    const rebuilt = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(rebuilt.files, plain.files);
    assert.deepEqual(rebuilt.diagnostics, plain.diagnostics);
    assert.deepEqual(snapshot(out), cold, "the rebuilt site is the cold build byte for byte");
    assert.deepEqual(leftovers(cacheDir), [], "the cold path cleaned its staging and lock");
    assert.equal(entries(cacheDir).length, 1, "the cold build repaired the entry");

    // The repaired entry is a hit, and still the same bytes.
    const hit = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(hit.files, first.files);
    assert.deepEqual(hit.diagnostics, first.diagnostics);
    assert.deepEqual(snapshot(out), cold);
    assert.deepEqual(leftovers(cacheDir), [], "a hit leaves no temporary state either");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
