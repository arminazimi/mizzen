/**
 * Issue #109: stale-lock recovery may not break a cache lock whose owner is still working.
 *
 * A restore or write of a large site can outlive any age threshold, so recovering a lock because it looks old hands
 * the cache to a second operation while the first is still publishing: the two then overlap, and a prune can remove
 * the entry the first is writing. These tests pin the rule that replaced age: a lock is abandoned when its recorded
 * owner is gone or was never fully recorded, never for age alone, while a lock folder is still recovered and replaced,
 * a bounded wait still ends in one cold build, and an operation that lost ownership can neither publish nor prune.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import {
  CACHE_FORMAT,
  CACHE_RETENTION,
  cacheLockInternals,
  restoreCache,
  writeCache,
  type CacheLockProbe,
  type CacheMissReason,
} from "../src/pipeline/cache.ts";

const { probeAbandonedLock, breakAbandonedLock, lockCache, unlockCache, ownsLock } = cacheLockInternals;

/** Older than the two-minute threshold this module used to abandon on: long restores legitimately take this long. */
const AGED_MS = 3 * 60_000;

/** The bound `lockCache` spends waiting before it gives up and builds cold; mirrors LOCK_WAIT_MS in the module. */
const LOCK_WAIT_MS = 20_000;

const KEY = /^[0-9a-f]{64}$/;

/** The files every fixture entry writes, in the order an entry records them. */
const FILES = ["assets/app.js", "index.html"];

/** A whole variant of a build output: its bytes and the diagnostics its entry records. */
interface Variant {
  readonly html: string;
  readonly js: string;
  readonly diagnostics: readonly Diagnostic[];
}

function variantOf(name: "A" | "B"): Variant {
  const marker = name === "A" ? "A" : "B";
  return {
    html: `<h1>${marker}</h1>\n`,
    js: `${marker.repeat(1000)}\n`,
    diagnostics: [{ id: `liveness.${name.toLowerCase()}`, severity: "warning", message: `${name}.` }],
  };
}

/** A source folder holding `files`, named for this issue. */
function sourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cache-lock-liveness-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A finished build output plus the file list and diagnostics an entry records for it. */
function sourceOf(variant: Variant): string {
  return sourceTree({ "index.html": variant.html, "assets/app.js": variant.js });
}

/** A temporary parent holding the output and the cache root, both named for this issue. */
function scratch(): { parent: string; out: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "cache-lock-liveness-"));
  return { parent, out: join(parent, "site"), cacheDir: join(parent, "cache") };
}

/** The cache entry folders: the ones named after a key. */
function entries(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && KEY.test(entry.name))
    .map((entry) => join(cacheDir, entry.name));
}

/** Every temporary or lock name in the cache root. */
function leftovers(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter(
    (name) => name === ".lock" || name.startsWith(".tmp-") || name.startsWith(".old-"),
  );
}

/** An entry as its manifest describes it, with every recorded hash checked against the bytes on disk. */
function verifyEntry(dir: string): { key: string; files: string[] } {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    version: number;
    key: string;
    files: string[];
    hashes: Record<string, string>;
  };
  assert.equal(manifest.version, CACHE_FORMAT, "the entry is one this engine wrote");
  assert.ok(KEY.test(manifest.key), "the entry names a key");
  for (const file of manifest.files) {
    const bytes = readFileSync(join(dir, "out", file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.hashes[file], `"${file}" matches its hash`);
  }
  return { key: manifest.key, files: [...manifest.files].sort() };
}

/** True while `pid` is in the process table; a reaped process is gone, a zombie is not. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that stays alive until retired, so a recorded lock owner is demonstrably still working. */
function liveOwner(): { pid: number; retire(): Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the holder has a PID");
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  return {
    pid: pid!,
    async retire(): Promise<void> {
      child.kill("SIGKILL");
      await closed;
      await reaped(pid!);
    },
  };
}

/** Waits until the exited PID no longer answers a liveness signal, so a breaker sees a dead owner. */
async function reaped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80 && pidIsAlive(pid); attempt++) await sleep(25);
  assert.equal(pidIsAlive(pid), false, `process ${pid} left the process table`);
}

/** The PID of a process that exited and was reaped, so a recorded owner is demonstrably dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the corpse has a PID");
  await new Promise<void>((done) => child.once("close", () => done()));
  await reaped(pid!);
  return pid!;
}

/**
 * A lock folder in `cacheDir` whose owner file holds `owner` (absent for a creation that never finished) and whose
 * mtime is `ageMs` old, as a long operation's lock looks to a competitor.
 */
function plantLock(cacheDir: string, owner: string | undefined, ageMs: number): { lock: string; bytes: string | undefined; ino: number } {
  const lock = join(cacheDir, ".lock");
  assert.equal(existsSync(lock), false, "no operation holds the lock while it is being planted");
  mkdirSync(lock);
  if (owner !== undefined) writeFileSync(join(lock, "owner"), owner);
  const past = new Date(Date.now() - ageMs);
  utimesSync(lock, past, past);
  return { lock, bytes: owner, ino: statSync(lock).ino };
}

/** The lock is exactly as it was planted: same folder, same inode, same owner record. */
function assertUntouched(held: { lock: string; bytes: string | undefined; ino: number }, why: string): void {
  assert.equal(existsSync(held.lock), true, `${why}: the lock folder is still there`);
  assert.equal(statSync(held.lock).ino, held.ino, `${why}: it is the same lock, not a replacement`);
  let owner: string | undefined;
  try {
    owner = readFileSync(join(held.lock, "owner"), "utf8");
  } catch {
    owner = undefined;
  }
  assert.equal(owner, held.bytes, `${why}: the recorded owner is untouched`);
}

/** Probes `lock`, insisting it is still there to inspect. */
async function probe(lock: string): Promise<CacheLockProbe> {
  const read = await probeAbandonedLock(lock);
  assert.ok(read !== undefined, "the lock is there to inspect");
  return read;
}

test("an aged lock whose owner is alive is neither abandoned nor broken", async () => {
  const { cacheDir } = scratch();
  mkdirSync(cacheDir, { recursive: true });
  const holder = liveOwner();
  try {
    // Both the test process and a separate live process own locks that are past the age threshold.
    for (const owner of [`${process.pid}\nwhole-build-still-running\n`, `${holder.pid}\nlong-restore\n`]) {
      const planted = plantLock(cacheDir, owner, AGED_MS);
      const read = await probe(planted.lock);
      assert.equal(
        read.abandoned,
        false,
        `a lock recorded to live process ${owner.split("\n")[0]} is not abandoned after ${AGED_MS}ms of work`,
      );
      assert.equal(await breakAbandonedLock(planted.lock, read), false, "a competitor may not break a live owner's lock");
      assertUntouched(planted, "the live owner keeps its lock");
      assert.equal(existsSync(`${planted.lock}.recover`), false, "a refused break leaves no recovery guard");
      rmSync(planted.lock, { recursive: true, force: true });
    }
  } finally {
    await holder.retire().catch(() => undefined);
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("dead owners and unfinished lock creation stay recoverable, at any age", async () => {
  const { cacheDir } = scratch();
  mkdirSync(cacheDir, { recursive: true });
  const holder = liveOwner();
  try {
    const gone = await deadPid();

    // A crashed writer's lock: its owner is gone, and that alone makes it abandoned, fresh or aged.
    for (const age of [0, AGED_MS]) {
      const planted = plantLock(cacheDir, `${gone}\ncrashed-writer\n`, age);
      const stale = await probe(planted.lock);
      assert.equal(stale.abandoned, true, `a dead owner's lock is abandoned (age ${age}ms)`);
      assert.equal(await breakAbandonedLock(planted.lock, stale), true, "the breaker recovers it");
      assert.equal(existsSync(planted.lock), false, "the recovered lock is gone");
    }

    // Creation that never recorded an owner is abandoned state once the grace period passed.
    const nameless = plantLock(cacheDir, undefined, AGED_MS);
    const namelessProbe = await probe(nameless.lock);
    assert.equal(namelessProbe.abandoned, true, "a lock with no owner is abandoned state");
    assert.equal(await breakAbandonedLock(nameless.lock, namelessProbe), true);
    assert.equal(existsSync(nameless.lock), false);

    // ...and is left alone while it is still inside the grace period, so a creator is not disturbed.
    const creating = plantLock(cacheDir, undefined, 0);
    const creatingProbe = await probe(creating.lock);
    assert.equal(creatingProbe.abandoned, false, "a lock still being created is not abandoned");
    assert.equal(await breakAbandonedLock(creating.lock, creatingProbe), false);
    assertUntouched(creating, "the creator keeps its half-made lock");
    rmSync(creating.lock, { recursive: true, force: true });

    // An owner record without its token never belonged to a working operation either.
    const noToken = plantLock(cacheDir, `${process.pid}\n`, AGED_MS);
    const noTokenProbe = await probe(noToken.lock);
    assert.equal(noTokenProbe.abandoned, true, "an owner record with no token is unfinished");
    assert.equal(await breakAbandonedLock(noToken.lock, noTokenProbe), true);
    const freshNoToken = plantLock(cacheDir, `${process.pid}\n`, 0);
    assert.equal((await probe(freshNoToken.lock)).abandoned, false, "and it too gets the grace period of a live creator");
    assertUntouched(freshNoToken, "the unfinished lock waits out its grace");
    rmSync(freshNoToken.lock, { recursive: true, force: true });

    // A live owner's aged lock is never recovered, even next to a recoverable one.
    const alive = plantLock(cacheDir, `${holder.pid}\npublishing\n`, AGED_MS);
    assert.equal((await probe(alive.lock)).abandoned, false, "a live owner's aged lock is never abandoned state");
    assertUntouched(alive, "the publishing operation keeps its lock");
    rmSync(alive.lock, { recursive: true, force: true });
  } finally {
    await holder.retire().catch(() => undefined);
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a breaker that lost the race never deletes the replacement lock", async () => {
  const { cacheDir } = scratch();
  mkdirSync(cacheDir, { recursive: true });
  try {
    const gone = await deadPid();
    const planted = plantLock(cacheDir, `${gone}\ncrashed-writer\n`, AGED_MS);
    const staleProbe = await probe(planted.lock);
    assert.equal(staleProbe.abandoned, true, "the crashed writer's lock is abandoned state");

    // The winning breaker recovers it and takes a replacement lock, as a live operation.
    assert.equal(await breakAbandonedLock(planted.lock, staleProbe), true);
    const held = await lockCache(cacheDir);
    assert.equal(typeof held, "object", "the winner took a fresh lock");
    if (typeof held === "string") return assert.fail("the replacement lock was not taken");

    // The losing breaker still holds its old view of the lock and must not act on it.
    assert.equal(await breakAbandonedLock(planted.lock, staleProbe), false, "the old view no longer matches the lock");
    assert.equal((await probe(planted.lock)).abandoned, false, "the replacement belongs to a live process");

    // An operation that lost ownership has none: it cannot publish, prune, or release the lock it no longer holds.
    assert.equal(await ownsLock(cacheDir, held.token), true, "the winner still owns the lock");
    assert.equal(await ownsLock(cacheDir, "00000000-0000-4000-8000-000000000000"), false, "a stale token owns nothing");
    await unlockCache(cacheDir, "00000000-0000-4000-8000-000000000000");
    assert.equal(existsSync(planted.lock), true, "the losing operation left the replacement lock alone");
    assert.match(readFileSync(join(planted.lock, "owner"), "utf8"), new RegExp(held.token));

    await unlockCache(cacheDir, held.token);
    assert.equal(existsSync(planted.lock), false, "the owner released its own lock");
    assert.deepEqual(leftovers(cacheDir), [], "no recovery guard or lock folder is left behind");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a competing operation keeps an aged live owner's lock and recovers it once that owner dies", async () => {
  const { parent, cacheDir, out } = scratch();
  const key = "1".repeat(64);
  const variant = variantOf("A");
  const source = sourceOf(variant);
  const holder = liveOwner();
  try {
    await writeCache(cacheDir, key, source, FILES, variant.diagnostics);
    const before = entries(cacheDir);
    const planted = plantLock(cacheDir, `${holder.pid}\nwhole-build-write\n`, AGED_MS);

    const misses: CacheMissReason[] = [];
    const competing = restoreCache(cacheDir, key, out, { onMiss: (reason) => misses.push(reason) });
    await sleep(700);

    assertUntouched(planted, "the waiter leaves an aged lock whose owner is alive");
    assert.deepEqual(misses, [], "it waits rather than reporting a miss mid-wait");
    assert.deepEqual(entries(cacheDir), before, "nothing is published or pruned without the lock");

    await holder.retire();
    const hit = await competing;
    assert.ok(hit !== undefined, "the same waiter recovers the lock once its owner is gone");
    assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), variant.html);
    assert.equal(readFileSync(join(hit.staging, "assets/app.js"), "utf8"), variant.js);
    assert.deepEqual(hit.diagnostics, variant.diagnostics);
    rmSync(hit.staging, { recursive: true, force: true });
    assert.deepEqual(misses, [], "the waiter never fell back to a cold build");
    assert.deepEqual(leftovers(cacheDir), [], "the recovered lock was released normally");
  } finally {
    await holder.retire().catch(() => undefined);
    rmSync(source, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a live owner's aged lock costs a waiter its bounded wait and one cold build, not the cache", async () => {
  const { parent, cacheDir, out } = scratch();
  const stored = "2".repeat(64);
  const unwritable = "3".repeat(64);
  const a = variantOf("A");
  const b = variantOf("B");
  const sourceA = sourceOf(a);
  const sourceB = sourceOf(b);
  const holder = liveOwner();
  try {
    await writeCache(cacheDir, stored, sourceA, FILES, a.diagnostics);
    const planted = plantLock(cacheDir, `${holder.pid}\nlarge-restore\n`, AGED_MS);
    const misses: CacheMissReason[] = [];

    const started = Date.now();
    const [read] = await Promise.all([
      restoreCache(cacheDir, stored, out, { onMiss: (reason) => misses.push(reason) }),
      writeCache(cacheDir, unwritable, sourceB, FILES, b.diagnostics),
    ]);
    const waited = Date.now() - started;

    assert.ok(
      waited >= LOCK_WAIT_MS - 500,
      `the wait is bounded by the full lock timeout, not by breaking a live owner early (${waited}ms)`,
    );
    assert.equal(read, undefined, "the reader gave up and builds cold");
    assert.deepEqual(misses, ["corrupt"], "a cold build is reported, once, as an unusable cache");
    assertUntouched(planted, "neither waiter broke the live owner's lock");
    assert.equal(existsSync(out), false, "a miss writes no output");

    const present = entries(cacheDir);
    assert.deepEqual(present.map((dir) => basename(dir)), [stored], "the waiter published nothing and pruned nothing");
    assert.equal(verifyEntry(present[0]!).key, stored, "the retained entry is complete and hash-verified");

    await holder.retire();
    assert.deepEqual(leftovers(cacheDir), [".lock"], "only the dead owner's lock remains");
    const hit = await restoreCache(cacheDir, stored, out, { onMiss: (reason) => misses.push(reason) });
    assert.ok(hit !== undefined, "the dead owner's lock is recovered by the next operation");
    assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), a.html);
    assert.deepEqual(hit.diagnostics, a.diagnostics);
    rmSync(hit.staging, { recursive: true, force: true });
    assert.deepEqual(leftovers(cacheDir), [], "the cache is left clean, with its entry intact");
  } finally {
    await holder.retire().catch(() => undefined);
    rmSync(sourceA, { recursive: true, force: true });
    rmSync(sourceB, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("concurrent restore, write and prune keep every retained entry complete across recovered crashes", async () => {
  const { parent, cacheDir, out } = scratch();
  const count = CACHE_RETENTION + 3;
  const keys = Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, "0"));
  const variants = keys.map((_, index): Variant => ({
    html: `<h1>liveness ${index}</h1>\n`,
    js: `${index}-`.repeat(2000),
    diagnostics: [{ id: `test.liveness.${index}`, severity: "warning", message: `Page ${index}.` }],
  }));
  const sources = variants.map((variant) => sourceOf(variant));
  try {
    for (let round = 0; round < 3; round++) {
      // Every round starts from a crashed writer's state: its lock, its staging, and its moved-aside backup.
      const gone = await deadPid();
      mkdirSync(join(cacheDir, ".tmp-liveness-crashed", "out"), { recursive: true });
      writeFileSync(join(cacheDir, ".tmp-liveness-crashed", "out", "index.html"), "<h1>partial</h1>\n");
      mkdirSync(join(cacheDir, ".old-liveness-crashed"), { recursive: true });
      plantLock(cacheDir, `${gone}\ncrashed-writer\n`, AGED_MS);

      await Promise.all([
        ...keys.map((key, index) => writeCache(cacheDir, key, sources[index]!, FILES, variants[index]!.diagnostics)),
        ...keys.map((key) =>
          restoreCache(cacheDir, key, out).then((hit) => {
            if (hit !== undefined) rmSync(hit.staging, { recursive: true, force: true });
          }),
        ),
      ]);
    }

    const present = entries(cacheDir);
    assert.equal(present.length, CACHE_RETENTION, "retention still bounds the cache after recovery");
    assert.deepEqual(leftovers(cacheDir), [], "crashed locks, staging, and backups are swept");
    for (const dir of present) {
      const key = basename(dir);
      const index = keys.indexOf(key);
      assert.ok(index >= 0, "only whole entries remain");
      const verified = verifyEntry(dir);
      assert.deepEqual(verified.files, FILES, "the manifest and its files agree");
      const hit = await restoreCache(cacheDir, key, out);
      assert.ok(hit !== undefined, `entry ${index} still restores`);
      assert.equal(readFileSync(join(hit.staging, "index.html"), "utf8"), variants[index]!.html, "and with its own bytes");
      assert.deepEqual(hit.diagnostics, variants[index]!.diagnostics);
      rmSync(hit.staging, { recursive: true, force: true });
    }
  } finally {
    for (const source of sources) rmSync(source, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
