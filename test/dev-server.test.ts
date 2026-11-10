import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEV_HOST,
  DIAGNOSTICS_PATH,
  dev,
  EVENTS_PATH,
  OVERLAY_MARKER,
  RELOAD_MARKER,
} from "../src/cli/dev.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dev-server-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary parent folder and the output folder inside it. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "dev-server-out-"));
  return { parent, out: join(parent, "site") };
}

/** The config and page every test starts from: a clean one-page site. */
const CONFIG = "title: Dev\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n";

test("serves index.html from the output folder on localhost and 404s a missing file", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    assert.equal(server.host, DEFAULT_DEV_HOST);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(existsSync(join(out, "index.html")), "the build wrote the output folder the server reads");

    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await home.text(), /Home/);

    const missing = await fetch(new URL("nowhere/", server.url));
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the reload client and the diagnostics endpoint exist only while serving", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, new RegExp(RELOAD_MARKER));
    assert.match(html, new RegExp(OVERLAY_MARKER));
    assert.ok(html.includes(EVENTS_PATH), "the page subscribes to reload events");
    assert.ok(html.includes(DIAGNOSTICS_PATH), "the page reads the latest diagnostics");

    const client = new RegExp(`<script ${RELOAD_MARKER}>([\\s\\S]*?)</script>`).exec(html)?.[1];
    assert.ok(client, "the page carries the inline dev client");
    assert.doesNotThrow(() => new Function(client), "the inline client is valid JavaScript");

    const events = await fetch(new URL(EVENTS_PATH, server.url));
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /^text\/event-stream/);
    await events.body?.cancel();

    const built = readFileSync(join(out, "index.html"), "utf8");
    assert.equal(built.includes(RELOAD_MARKER), false, "the built page has no dev client");
    assert.equal(built.includes(OVERLAY_MARKER), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the diagnostics overlay reports a failed build and clears after a clean rebuild", async () => {
  const root = tree({
    "mizzen.yml": CONFIG,
    "index.md": "---\nlayout: nope\n---\n# Home\n",
  });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200, "a failed build still serves the page the overlay sits on");
    const html = await page.text();
    assert.ok(html.includes(OVERLAY_MARKER));
    assert.ok(html.includes(DIAGNOSTICS_PATH));

    const failed = await fetch(new URL(DIAGNOSTICS_PATH, server.url));
    assert.equal(failed.status, 200);
    assert.match(failed.headers.get("content-type") ?? "", /^application\/json/);
    const report = (await failed.json()) as {
      version: number;
      diagnostics: { id: string; severity: string; message: string }[];
    };
    assert.equal(report.version, 1);
    assert.ok(
      report.diagnostics.some((d) => d.id === "render.unknown-layout" && d.severity === "error"),
      "the overlay shows the failed build",
    );

    writeFileSync(join(root, "index.md"), "# Home\n");
    const build = await server.rebuild("clean rebuild");
    assert.deepEqual(build.diagnostics, []);

    const clean = await fetch(new URL(DIAGNOSTICS_PATH, server.url));
    assert.equal(clean.status, 200);
    assert.deepEqual(((await clean.json()) as { diagnostics: unknown[] }).diagnostics, []);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
