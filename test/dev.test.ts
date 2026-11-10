import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/index.ts";
import { DEFAULT_DEV_HOST, DEFAULT_DEV_PORT, dev, EVENTS_PATH, RELOAD_MARKER } from "../src/cli/dev.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** Folders other test files write into the fixture while it is being copied; a build cache is never input. */
const TRANSIENT = new Set([".mizzen", ".tmp", "node_modules", ".git"]);

/** Copies the fixture without the folders a concurrent build may be writing, so the copy cannot race. */
function copyFixture(to: string): void {
  cpSync(FIXTURE, to, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => TRANSIENT.has(part)),
  });
}

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dev-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary folder for the output; its parent is removed by the test. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "dev-out-"));
  return { parent, out: join(parent, "site") };
}

/** Gives the recursive watcher a moment to attach, so a write made immediately after `dev` returns is not missed. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

/** Reads the event stream until a reload arrives, or fails when it closes or the deadline passes. */
async function waitForReload(response: Response, timeoutMs = 20_000): Promise<void> {
  const body = response.body;
  assert.notEqual(body, null, "the event endpoint has a body");
  const reader = body!.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => {
    void reader.cancel(new Error("timed out waiting for a reload event"));
  }, timeoutMs);
  let seen = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the event stream closed before a reload; saw ${JSON.stringify(seen)}`);
      seen += decoder.decode(value, { stream: true });
      if (seen.includes("event: reload")) return;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

test("parseArgs: dev defaults, flags, and usage errors", () => {
  assert.deepEqual(parseArgs(["dev"]), {
    options: { command: "dev", root: ".", port: DEFAULT_DEV_PORT, host: DEFAULT_DEV_HOST },
  });
  assert.deepEqual(parseArgs(["dev", "site", "--port", "0", "--host", "0.0.0.0", "--out", "_site", "--theme", "/t"]), {
    options: {
      command: "dev",
      root: "site",
      out: "_site",
      port: 0,
      host: "0.0.0.0",
      theme: "/t",
    },
  });
  assert.equal("error" in parseArgs(["build", "--port", "3000"]), true);
  assert.equal("error" in parseArgs(["check", "--host", "localhost"]), true);
  assert.equal("error" in parseArgs(["dev", "--port", "nope"]), true);
  assert.equal("error" in parseArgs(["dev", "--port", "70000"]), true);
  assert.equal("error" in parseArgs(["dev", "--format", "json"]), true);
});

test("dev serves pretty URLs with content types and injects the reload client only in responses", async () => {
  const root = tree({
    "mizzen.yml": "title: Dev\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Home\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n",
    "style.css": "body { color: black; }\n",
  });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0, host: "127.0.0.1" });
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await home.text(), new RegExp(RELOAD_MARKER));

    const guide = await fetch(new URL("guide/install", server.url));
    assert.equal(guide.status, 200, "a pretty URL without its trailing slash serves the page");
    assert.match(await guide.text(), /Install/);

    const slash = await fetch(new URL("guide/install/", server.url));
    assert.equal(slash.status, 200);

    const css = await fetch(new URL("style.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /^text\/css/);

    const missing = await fetch(new URL("nowhere/", server.url));
    assert.equal(missing.status, 404);

    assert.equal(readFileSync(join(out, "index.html"), "utf8").includes(RELOAD_MARKER), false, "the built page has no client");
    assert.equal(readFileSync(join(out, "guide/install/index.html"), "utf8").includes(RELOAD_MARKER), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a source change rebuilds and sends a reload event before the next request", async () => {
  const root = tree({
    "mizzen.yml": "title: Dev\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "note.md": "# Before\n",
  });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0, host: "127.0.0.1" });
  try {
    const events = await fetch(new URL(EVENTS_PATH, server.url));
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reload = waitForReload(events);
    await settle();

    const before = await fetch(new URL("note/", server.url));
    assert.match(await before.text(), /Before/);

    const started = performance.now();
    writeFileSync(join(root, "note.md"), "# After the change\n");
    await reload;
    const milliseconds = performance.now() - started;

    const after = await fetch(new URL("note/", server.url));
    assert.match(await after.text(), /After the change/);
    assert.ok(milliseconds < 15_000);

    const build = await server.rebuild("manual rebuild");
    assert.ok(build.milliseconds >= 0);
    assert.ok(build.files.includes("note/index.html"));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a change to fixtures/docs-site is picked up, and its rebuild time is reported", async (t) => {
  const { parent, out } = scratch();
  const root = join(parent, "docs-site");
  copyFixture(root);
  const server = await dev({ root, out, themeRoot: THEME, port: 0, host: "127.0.0.1", defaultLayout: "doc" });
  try {
    const events = await fetch(new URL(EVENTS_PATH, server.url));
    const reload = waitForReload(events, 60_000);
    await settle();

    const started = performance.now();
    const faq = readFileSync(join(root, "faq.md"), "utf8");
    writeFileSync(join(root, "faq.md"), `${faq}\n# Rebuilt by the dev test\n`);
    await reload;
    const milliseconds = performance.now() - started;

    const page = await fetch(new URL("faq/", server.url));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Rebuilt by the dev test/);
    t.diagnostic(`fixtures/docs-site rebuild: ${Math.round(milliseconds)} ms (target: under 500 ms)`);
  } finally {
    await server.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
