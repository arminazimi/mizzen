import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DIAGNOSTICS_PATH,
  dev,
  EVENTS_PATH,
  RELOAD_MARKER,
  type DevServer,
} from "../src/cli/dev.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const SECRET = "TOP-SECRET-56";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-dev-security-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary parent folder and the output folder inside it. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "cli-dev-security-out-"));
  return { parent, out: join(parent, "site") };
}

/** The config every test starts from. */
const CONFIG = "title: Dev\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n";

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Sends one request with a literal request target, so encoded and unnormalized paths reach the server as written. */
function request(server: DevServer, target: string, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: server.host, port: server.port, path: target, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens a reload stream and leaves it open; the caller destroys it. */
function openEvents(server: DevServer): Promise<{ status: number; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: server.host, port: server.port, path: EVENTS_PATH }, (res) => {
      resolve({ status: res.statusCode ?? 0, res });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The headers every dynamic response must carry: no sniffing and no caching. */
function assertBoundaryHeaders(reply: Reply): void {
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
  assert.match(String(reply.headers["cache-control"] ?? ""), /no-store/);
}

test("traversal, encoded traversal, absolute and backslash paths never leave the output folder", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const secret = join(parent, "secret.txt");
  writeFileSync(secret, `${SECRET}\n`);
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const targets = [
      "/../secret.txt",
      "/../../etc/passwd",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/..%2fsecret.txt",
      "/..%2F..%2Fsecret.txt",
      "/..%5csecret.txt",
      "/..\\secret.txt",
      "/%2e%2e%5csecret.txt",
      "/..%252fsecret.txt",
      "file:///etc/passwd",
      "/etc/passwd",
      "/secret.txt",
    ];
    for (const target of targets) {
      const reply = await request(server, target);
      assert.ok([400, 404].includes(reply.status), `${target} is rejected, got ${reply.status}`);
      assert.equal(reply.body.includes(SECRET), false, `${target} never returns the file above the output folder`);
      assert.equal(reply.body.includes("root:"), false, `${target} never returns /etc/passwd`);
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("symlinks and special files are not served from outside the output folder", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const outside = join(parent, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    symlinkSync(join(outside, "secret.txt"), join(out, "leak.txt"));
    symlinkSync(join(outside, "secret.txt"), join(out, "leak"));
    symlinkSync(outside, join(out, "leakdir"));
    symlinkSync(join(out, "loop"), join(out, "loop"));
    execFileSync("mkfifo", [join(out, "pipe")]);
    for (const target of ["/leak.txt", "/leak", "/leakdir/secret.txt", "/leakdir/", "/loop", "/pipe"]) {
      const reply = await request(server, target);
      assert.equal(reply.status, 404, `${target} is not served, got ${reply.status}`);
      assert.equal(reply.body.includes(SECRET), false, `${target} never returns the symlink target`);
    }
    const home = await request(server, "/");
    assert.equal(home.status, 200, "a normal page still serves beside the rejected entries");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("only GET and HEAD are allowed, and HEAD carries headers without a body", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n", "style.css": "body{}\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const get = await request(server, "/");
    assert.equal(get.status, 200);
    assertBoundaryHeaders(get);
    assert.match(String(get.headers["content-type"] ?? ""), /^text\/html/);
    assert.ok(get.body.includes(RELOAD_MARKER));

    const head = await request(server, "/", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], get.headers["content-length"], "HEAD advertises the GET length");

    const css = await request(server, "/style.css");
    assert.match(String(css.headers["content-type"] ?? ""), /^text\/css/);
    assert.equal(css.body.includes(RELOAD_MARKER), false, "non-HTML responses are never injected");
    const cssHead = await request(server, "/style.css", "HEAD");
    assert.equal(cssHead.body, "");
    assert.equal(cssHead.headers["content-length"], css.headers["content-length"]);

    const diagnostics = await request(server, DIAGNOSTICS_PATH);
    assert.equal(diagnostics.status, 200);
    assertBoundaryHeaders(diagnostics);
    const report = JSON.parse(diagnostics.body) as { version: number; diagnostics: unknown[] };
    assert.equal(report.version, 1);
    assert.ok(Array.isArray(report.diagnostics));
    const diagnosticsHead = await request(server, DIAGNOSTICS_PATH, "HEAD");
    assert.equal(diagnosticsHead.body, "");
    assert.equal(diagnosticsHead.headers["content-length"], diagnostics.headers["content-length"]);

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const target of ["/", DIAGNOSTICS_PATH, EVENTS_PATH, "/nowhere/"]) {
        const reply = await request(server, target, method);
        assert.equal(reply.status, 405, `${method} ${target} is refused`);
        assert.equal(reply.headers.allow, "GET, HEAD");
        assert.equal(reply.body, "");
        assertBoundaryHeaders(reply);
      }
    }

    const missingHead = await request(server, "/nowhere/", "HEAD");
    assert.equal(missingHead.status, 404);
    assert.equal(missingHead.body, "");

    const eventsHead = await request(server, EVENTS_PATH, "HEAD");
    assert.equal(eventsHead.status, 200);
    assert.equal(eventsHead.body, "");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("malformed URLs and percent encoding answer 400 instead of throwing", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const malformed = ["/%zz", "/%e0%a4%a", "/bad%f0%28%8c%28", "/%00", "http://[bad", "http://[::1"];
    for (const target of malformed) {
      const reply = await request(server, target);
      assert.equal(reply.status, 400, `${target} is a bad request, got ${reply.status}`);
      assert.equal(reply.body, "400\n");
      assertBoundaryHeaders(reply);
      assert.match(String(reply.headers["content-type"] ?? ""), /^text\/plain/);
      const head = await request(server, target, "HEAD");
      assert.equal(head.status, 400);
      assert.equal(head.body, "");
    }

    const missing = await request(server, "/nowhere/");
    assert.equal(missing.status, 404);
    assert.match(missing.body, /Page not found/);
    assertBoundaryHeaders(missing);

    writeFileSync(join(out, "404.html"), "<!doctype html><p>Custom missing</p>");
    const custom = await request(server, "/nowhere/");
    assert.equal(custom.status, 404);
    assert.match(custom.body, /Custom missing/);
    assert.ok(custom.body.includes(RELOAD_MARKER), "a custom 404 page is still HTML");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("pretty URLs, base paths and on-disk output keep working", async () => {
  const root = tree({
    "mizzen.yml": "title: Dev\nbase: /docs\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Home\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n",
    "style.css": "body { color: black; }\n",
  });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    assert.match(server.url, /\/docs\/$/);
    for (const target of ["/docs/", "/docs/guide/install", "/docs/guide/install/", "/docs/style.css"]) {
      const reply = await request(server, target);
      assert.equal(reply.status, 200, `${target} still resolves`);
    }

    const before = readFileSync(join(out, "index.html"), "utf8");
    const reply = await request(server, "/docs/");
    assert.ok(reply.body.includes(RELOAD_MARKER));
    const after = readFileSync(join(out, "index.html"), "utf8");
    assert.equal(before, after, "serving injected HTML never rewrites the output folder");
    assert.equal(after.includes(RELOAD_MARKER), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("reload streams are bounded, freed on disconnect, and end at close", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  const streams: IncomingMessage[] = [];
  try {
    // The bound is an implementation detail; enough simultaneous tabs must not be accepted forever.
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 100; i += 1) {
      const opened = await openEvents(server);
      if (opened.status === 200) {
        accepted += 1;
        streams.push(opened.res);
      } else {
        refused = opened.status;
        opened.res.resume();
        assert.equal(refused, 503, "a stream past the bound is refused with 503");
        break;
      }
    }
    assert.ok(accepted > 0, "reload streams work");
    assert.equal(refused, 503, "the stream bound is enforced");

    for (const stream of streams) stream.destroy();
    streams.length = 0;

    let recovered = false;
    const deadline = Date.now() + 5000;
    while (!recovered && Date.now() < deadline) {
      const opened = await openEvents(server);
      if (opened.status === 200) {
        recovered = true;
        streams.push(opened.res);
      } else {
        opened.res.resume();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(recovered, "disconnected clients free their slot");
  } finally {
    for (const stream of streams) stream.destroy();
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("close waits for a build in flight, ends streams, and refuses later requests", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const opened = await openEvents(server);
    assert.equal(opened.status, 200);
    const ended = new Promise<void>((resolve) => opened.res.on("end", () => resolve()));
    opened.res.resume();

    const building = server.rebuild("while closing");
    const closed = server.close();
    const build = await building;
    await closed;
    assert.ok(build.files.includes("index.html"), "the build in flight finished before close resolved");
    await ended;
    await server.closed;

    await assert.rejects(request(server, "/"), "nothing is served once the server is closed");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
