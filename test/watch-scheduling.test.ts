import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WATCH_DEBOUNCE_MS,
  DEFAULT_WATCH_MAX_DELAY_MS,
  watch,
  WatchScheduler,
  type WatchHandle,
  type WatchSource,
  type WatchTimers,
} from "../src/cli/watch.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A timer source whose time only moves when a test says so. */
class FakeClock implements WatchTimers {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly run: () => void }>();

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + milliseconds, run: callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** Runs every timer due by `milliseconds`, in deadline then creation order. */
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      let due: [number, { readonly at: number; readonly run: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at > target) continue;
        if (due === undefined || entry[1].at < due[1].at) due = entry;
      }
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].run();
    }
    this.#now = target;
  }
}

/** One fake watcher, so a test can raise an event, a filename-less event, or a failure on demand. */
interface FakeHandle extends WatchHandle {
  readonly dir: string;
  readonly closed: boolean;
  change(filename: string | null): void;
  fail(error: Error): void;
}

/** A watcher source that records every open and can refuse a root, standing in for a deleted or recreated folder. */
class FakeSource implements WatchSource {
  readonly handles: FakeHandle[] = [];
  readonly opens: string[] = [];
  readonly unavailable = new Set<string>();

  open(dir: string, onChange: (filename: string | null) => void, onFailure: (error: Error) => void): WatchHandle {
    this.opens.push(dir);
    if (this.unavailable.has(dir)) throw new Error(`cannot watch ${dir}`);
    let closed = false;
    const handle: FakeHandle = {
      dir,
      get closed() {
        return closed;
      },
      change(filename) {
        if (!closed) onChange(filename);
      },
      fail(error) {
        if (closed) return;
        closed = true;
        onFailure(error);
      },
      close() {
        closed = true;
      },
    };
    this.handles.push(handle);
    return handle;
  }

  /** The newest handle for `dir`; an older one may still be present after a failure. */
  last(dir: string): FakeHandle | undefined {
    return this.handles.filter((handle) => handle.dir === dir).at(-1);
  }
}

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "watch-scheduling-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary folder for the output; the test removes its parent. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "watch-scheduling-out-"));
  return { parent, out: join(parent, "site") };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Gives the recursive watcher a moment to attach before the first write. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

/** Lets pending promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Reads a file, or an empty string while a rebuild has not written it yet. */
function text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Polls `check` until it is true, or fails after `timeoutMs`. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** The rebuild lines of the watcher's log; the initial build is named separately. */
function changeLines(logs: readonly string[]): string[] {
  return logs.filter((line) => line.startsWith("mizzen watch: change in "));
}

test("a continuous burst is bounded by the maximum delay and logs one deterministic reason", async () => {
  const clock = new FakeClock();
  const runs: string[] = [];
  const scheduler = new WatchScheduler<number>({
    quietMs: 40,
    maxMs: 200,
    timers: clock,
    run: (reason) => {
      runs.push(reason);
      return Promise.resolve(runs.length);
    },
  });

  // Every event restarts the quiet period, but the maximum is measured from the first one.
  for (let i = 0; i < 9; i++) {
    scheduler.notify("change in the site");
    clock.advance(20);
  }
  assert.deepEqual(runs, [], "a burst shorter than the maximum is still waiting");
  clock.advance(20);
  await scheduler.settled();
  assert.deepEqual(runs, ["change in the site"], "the maximum delay starts exactly one build");
  assert.equal(clock.pending, 0, "the build consumed both timers");

  runs.length = 0;
  scheduler.notify("change in the theme");
  scheduler.notify("change in the site");
  scheduler.notify("change in the theme");
  clock.advance(40);
  await scheduler.settled();
  assert.deepEqual(runs, ["change in the site, change in the theme"], "duplicate reasons collapse and sort");
  assert.equal(clock.pending, 0);
});

test("events during a build schedule exactly one follow-up that reads the settled tree", async () => {
  const clock = new FakeClock();
  const runs: string[] = [];
  const releases: Array<() => void> = [];
  const scheduler = new WatchScheduler<void>({
    quietMs: 10,
    maxMs: 100,
    timers: clock,
    run: (reason) => {
      runs.push(reason);
      return new Promise<void>((resolveBuild) => releases.push(resolveBuild));
    },
  });

  scheduler.notify("change in the site");
  clock.advance(10);
  assert.deepEqual(runs, ["change in the site"], "the quiet period starts the first build");

  // Both events land while the first build is still in flight.
  scheduler.notify("change in the site");
  scheduler.notify("change in the theme");
  clock.advance(10_000);
  assert.equal(runs.length, 1, "no second build starts while the first is running");

  releases[0]!();
  await flush();
  assert.equal(runs.length, 1, "the follow-up waits for its quiet period instead of queueing immediately");

  clock.advance(10);
  assert.deepEqual(runs, ["change in the site", "change in the site, change in the theme"]);
  releases[1]!();
  await scheduler.settled();
  assert.equal(runs.length, 2, "a burst during one build produces one follow-up, not one per event");
  assert.equal(clock.pending, 0);
});

test("rapid events stay one build and stop cancels timers, rejects queued rebuilds, and waits for the build in flight", async () => {
  const clock = new FakeClock();
  const runs: string[] = [];
  let release: (() => void) | undefined;
  const scheduler = new WatchScheduler<number>({
    quietMs: 10,
    maxMs: 100,
    timers: clock,
    run: (reason) => {
      runs.push(reason);
      return new Promise<number>((resolveBuild) => {
        release = () => resolveBuild(runs.length);
      });
    },
  });

  for (let i = 0; i < 500; i++) scheduler.notify("change in the site");
  clock.advance(10);
  assert.equal(runs.length, 1, "five hundred events become one build");

  const queued = scheduler.request("manual rebuild");
  const queuedCheck = assert.rejects(queued, /watcher is closed/);
  const stopped = scheduler.stop();
  assert.equal(clock.pending, 0, "stop clears every timer");

  let done = false;
  void stopped.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false, "stop waits for the build in flight");
  await queuedCheck;

  release!();
  await stopped;
  assert.equal(runs.length, 1, "the queued rebuild is not started after stop");
  clock.advance(10_000);
  await flush();
  assert.equal(runs.length, 1, "no timer survives stop");
  assert.equal(clock.pending, 0);
  await scheduler.settled();
});

test("filename-less events rebuild, while the output and ignored folders do not", async () => {
  const root = tree({ "mizzen.yml": "title: Watch\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n", "index.md": "# Before\n" });
  const { parent } = scratch();
  // The default output sits inside the site, which is the case that can otherwise loop.
  const out = join(root, ".mizzen", "watch");
  const clock = new FakeClock();
  const source = new FakeSource();
  const logs: string[] = [];
  const watcher = await watch({
    root,
    out,
    themeRoot: THEME,
    debounceMs: 20,
    maxDelayMs: 100,
    timers: clock,
    watchSource: source,
    log: (message) => logs.push(message),
  });
  try {
    const site = source.last(root);
    assert.notEqual(site, undefined, "the site root is watched");

    site!.change(".mizzen/watch/index.html");
    site!.change("node_modules/package/index.js");
    site!.change("index.md~");
    site!.change(".DS_Store");
    clock.advance(DEFAULT_WATCH_MAX_DELAY_MS);
    await sleep(200);
    assert.deepEqual(changeLines(logs), [], "output and ignored paths schedule no rebuild");

    writeFileSync(join(root, "index.md"), "# After a filename-less event\n");
    site!.change(null);
    clock.advance(20);
    await waitFor(() => text(join(out, "index.html")).includes("After a filename-less event"), "the rebuilt page");
    await waitFor(() => changeLines(logs).length >= 1, "the filename-less rebuild line");
    assert.equal(changeLines(logs).length, 1);
    assert.match(changeLines(logs)[0]!, /^mizzen watch: change in the site in \d+ ms$/);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("watcher failure is surfaced, rebuilds, and reattaches a recreated root", async () => {
  const root = tree({ "mizzen.yml": "title: Watch\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n", "index.md": "# Before\n" });
  const { parent, out } = scratch();
  const clock = new FakeClock();
  const source = new FakeSource();
  const logs: string[] = [];
  const watcher = await watch({
    root,
    out,
    themeRoot: THEME,
    debounceMs: 20,
    maxDelayMs: 100,
    timers: clock,
    watchSource: source,
    log: (message) => logs.push(message),
  });
  try {
    assert.ok(source.opens.includes(root), "the site root is watched");
    assert.ok(source.opens.includes(THEME), "the theme is watched");

    // The recovery build must see the tree as it was when the watcher failed.
    writeFileSync(join(root, "index.md"), "# Recovered\n");
    source.unavailable.add(root);
    source.last(root)!.fail(new Error("EPERM: the watcher died"));

    assert.ok(
      logs.some((line) => line.includes("watcher error for the site: EPERM") && line.includes("rebuilding to recover")),
      `the failure is surfaced: ${JSON.stringify(logs)}`,
    );
    assert.equal(source.opens.filter((dir) => dir === root).length, 2, "the failed watcher is reattached immediately");
    assert.ok(logs.some((line) => line.includes("cannot watch the site") && line.includes("retrying")), "a root that cannot open is retried");

    clock.advance(20);
    await waitFor(() => text(join(out, "index.html")).includes("Recovered"), "the recovery build");
    await waitFor(() => changeLines(logs).length >= 1, "the recovery rebuild line");
    assert.match(changeLines(logs)[0] ?? "", /^mizzen watch: change in the site in \d+ ms$/);

    // The retry timer fires after the maximum delay, once the root is back.
    source.unavailable.delete(root);
    clock.advance(100);
    const site = source.last(root);
    assert.notEqual(site, undefined);
    assert.equal(site!.closed, false, "a recreated root is watched again");

    writeFileSync(join(root, "index.md"), "# After recreation\n");
    site!.change("index.md");
    clock.advance(20);
    await waitFor(() => text(join(out, "index.html")).includes("After recreation"), "the rebuild after recreation");
    await waitFor(() => changeLines(logs).length >= 2, "the rebuilt line after recreation");
    assert.equal(changeLines(logs).length, 2, "the reattached watcher keeps updating");
  } finally {
    await watcher.stop();
    assert.equal(clock.pending, 0, "stop leaves no timer behind");
    assert.ok(source.handles.every((handle) => handle.closed), "stop closes every watcher");
    await assert.rejects(watcher.rebuild("after stop"), /watcher is closed/);
    await watcher.stop();
    await watcher.closed;
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an atomic editor save is rebuilt from the settled file", async () => {
  const root = tree({
    "mizzen.yml": "title: Watch\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Before\n",
  });
  const { parent, out } = scratch();
  const logs: string[] = [];
  const watcher = await watch({
    root,
    out,
    themeRoot: THEME,
    debounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
    log: (message) => logs.push(message),
  });
  try {
    assert.match(text(join(out, "index.html")), /Before/);
    await settle();

    // The sequence editors use: write beside the page, then rename over it.
    writeFileSync(join(root, ".index.md.atomic"), "# Saved atomically\n");
    renameSync(join(root, ".index.md.atomic"), join(root, "index.md"));

    await waitFor(() => text(join(out, "index.html")).includes("Saved atomically"), "the atomically saved page");
    await waitFor(() => changeLines(logs).length >= 1, "the atomic-save rebuild line");
    assert.equal(existsSync(join(out, "index.html")), true);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a change during a slow build is followed by a build of the final content", async (t) => {
  const root = tree({
    "mizzen.yml": "title: Watch\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Before\n",
  });
  const { parent, out } = scratch();
  const builds = join(parent, "builds.log");
  writeFileSync(
    join(root, "mizzen.config.ts"),
    `import { appendFileSync } from "node:fs";
export default {
  plugins: [
    {
      name: "slow",
      async model(site) {
        appendFileSync(${JSON.stringify(builds)}, "start\\n");
        await new Promise((resolve) => setTimeout(resolve, 200));
        return site;
      },
    },
  ],
};
`,
  );
  const logs: string[] = [];
  const watcher = await watch({
    root,
    out,
    themeRoot: THEME,
    debounceMs: 20,
    maxDelayMs: 100,
    log: (message) => logs.push(message),
  });
  try {
    const starts = (): number => text(builds).split("\n").filter((line) => line === "start").length;
    assert.equal(starts(), 1, "the initial build ran once");
    await settle();

    writeFileSync(join(root, "index.md"), "# First\n");
    await waitFor(() => starts() >= 2, "the first change to start a build");

    // This lands while that build is still in its plugin hook.
    writeFileSync(join(root, "index.md"), "# Second\n");
    await waitFor(() => text(join(out, "index.html")).includes("Second"), "the settled final content");
    await waitFor(() => changeLines(logs).length >= 2, "the two logged change builds");
    assert.ok(starts() >= 3, "events during a build produce a follow-up build");
    t.diagnostic(`slow-build follow-up: ${starts()} builds, ${changeLines(logs).length} change rebuilds`);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
