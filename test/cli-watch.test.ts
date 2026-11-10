import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, usage } from "../src/cli/index.ts";
import { DEFAULT_WATCH_DEBOUNCE_MS, watch } from "../src/cli/watch.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "watch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary folder for the output; the test removes its parent. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "watch-out-"));
  return { parent, out: join(parent, "site") };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Gives the recursive watcher a moment to attach before the first write. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
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

/** The build time the watcher last reported, in milliseconds. */
function reportedMilliseconds(line: string | undefined): number {
  const match = / in (\d+) ms$/.exec(line ?? "");
  assert.notEqual(match, null, `a rebuild line reports its time: ${line ?? "(none)"}`);
  return Number(match![1]);
}

test("parseArgs: watch defaults, flags, and usage errors", () => {
  assert.deepEqual(parseArgs(["watch"]), { options: { command: "watch", root: "." } });
  assert.deepEqual(parseArgs(["watch", "site", "--out", "_site", "--theme", "/t"]), {
    options: { command: "watch", root: "site", out: "_site", theme: "/t" },
  });
  assert.equal("error" in parseArgs(["watch", "--port", "3000"]), true);
  assert.equal("error" in parseArgs(["watch", "--format", "json"]), true);
  assert.equal("error" in parseArgs(["watch", "--hash", "0".repeat(64)]), true);
  assert.match(usage, /watch \[dir\]/);
});

test("one change triggers exactly one rebuild, writes the output, and reports its time", async (t) => {
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
    log: (message) => logs.push(message),
  });
  try {
    assert.match(text(join(out, "index.html")), /Before/, "the initial build writes the output");
    assert.equal(existsSync(join(root, ".slipway", "cache")), false, "cache is off unless asked for");
    await settle();

    const started = performance.now();
    writeFileSync(join(root, "index.md"), "# After\n");
    await waitFor(() => changeLines(logs).length >= 1, "the first rebuild");
    await waitFor(() => text(join(out, "index.html")).includes("After"), "the rebuilt page");
    const wall = performance.now() - started;

    // A single edit must not be followed by a second build once the debounce window has passed.
    await sleep(DEFAULT_WATCH_DEBOUNCE_MS * 5);
    assert.equal(changeLines(logs).length, 1, "one change builds once");
    const build = reportedMilliseconds(changeLines(logs)[0]);

    // The target is 500 ms; the bound is generous so a slow CI machine is reported, not failed.
    assert.ok(wall < 10_000, `rebuild took ${Math.round(wall)} ms`);
    assert.ok(build < 10_000, `build took ${build} ms`);
    t.diagnostic(`watch rebuild: ${Math.round(wall)} ms wall, ${build} ms build (target: under 500 ms)`);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("two quick changes coalesce into one rebuild that sees the last one", async (t) => {
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
    debounceMs: 150,
    log: (message) => logs.push(message),
  });
  try {
    await settle();

    writeFileSync(join(root, "index.md"), "# First\n");
    await sleep(20);
    writeFileSync(join(root, "index.md"), "# Second\n");
    await waitFor(() => changeLines(logs).length >= 1, "the coalesced rebuild");
    await waitFor(() => text(join(out, "index.html")).includes("Second"), "the rebuilt page");

    await sleep(500);
    assert.equal(changeLines(logs).length, 1, "two changes inside the window build once");
    assert.match(text(join(out, "index.html")), /Second/);
    t.diagnostic(`coalesced burst: ${changeLines(logs).length} rebuild`);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cache is passed to every build, and stop closes the watchers and resolves closed", async () => {
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
    cache: true,
    log: (message) => logs.push(message),
  });
  try {
    const cacheRoot = join(root, ".slipway", "cache");
    assert.equal(existsSync(cacheRoot), true, "the initial build writes a cache entry");
    assert.ok(
      readdirSync(cacheRoot).some((entry) => /^[0-9a-f]{64}$/.test(entry)),
      "the entry is keyed by the build hash",
    );

    // SIGINT is process-level, handled in cli/index.ts; stop() and closed are the testable path.
    await watcher.stop();
    await watcher.closed;
    assert.equal(logs.at(-1), "mizzen watch: stopped");

    const before = changeLines(logs).length;
    writeFileSync(join(root, "index.md"), "# After stopping\n");
    await sleep(400);
    assert.equal(changeLines(logs).length, before, "a closed watcher ignores later changes");

    await watcher.stop();
    await watcher.closed;
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
