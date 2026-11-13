import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dev, RELOAD_MARKER, type DevServer } from "../src/cli/dev.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** Big enough that buffering the whole file is visible in memory, small enough that a loopback copy stays quick. */
const ASSET_SIZE = 32 * 1024 * 1024;

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dev-server-streaming-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary parent folder and the output folder inside it. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "dev-server-streaming-out-"));
  return { parent, out: join(parent, "site") };
}

/** The config and page every test starts from. */
const CONFIG = "title: Dev\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n";

/** A sparse file of `size` bytes with recognizable ends, so a truncated or padded response cannot pass. */
function sparseAsset(path: string, size: number): void {
  const start = "mizzen-stream-start";
  const end = "mizzen-stream-end";
  const fd = openSync(path, "w");
  try {
    writeSync(fd, start);
    ftruncateSync(fd, size);
    writeSync(fd, end, size - end.length);
  } finally {
    closeSync(fd);
  }
}

/** The SHA-256 and length of a file on disk, read in pieces so the check itself stays small. */
async function digest(path: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { hash: hash.digest("hex"), bytes };
}

interface StreamedReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: number;
  readonly hash: string;
  /** `arrayBuffers` when the headers arrived: a buffered file is already allocated at that point. */
  readonly buffersAtHeaders: number;
}

/** Requests `target`, hashing the body as it arrives instead of keeping it, and reports memory at the headers. */
function download(server: DevServer, target: string, method = "GET"): Promise<StreamedReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: server.host, port: server.port, path: target, method }, (res) => {
      const buffersAtHeaders = process.memoryUsage().arrayBuffers;
      const hash = createHash("sha256");
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.byteLength;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bytes,
          hash: hash.digest("hex"),
          buffersAtHeaders,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Starts a download and stops reading at the headers, so the server cannot finish writing the body. */
function stalledDownload(server: DevServer, target: string): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: server.host, port: server.port, path: target }, (res) => {
      res.pause();
      resolve({ req, res });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The descriptor table of this process: `/dev/fd` on macOS, `/proc/self/fd` on Linux. */
function descriptorTable(): string {
  return existsSync("/dev/fd") ? "/dev/fd" : "/proc/self/fd";
}

/** How many descriptors this process holds on `path`. Each entry stats to the open file on both platforms. */
function openOn(path: string): number {
  const table = descriptorTable();
  const wanted = statSync(path).ino;
  let count = 0;
  for (const entry of readdirSync(table)) {
    try {
      if (statSync(join(table, entry)).ino === wanted) count += 1;
    } catch {
      // A descriptor that vanished while the table was read is not counted.
    }
  }
  return count;
}

/** Waits for a condition, then says whether it holds; polling keeps the check independent of event ordering. */
async function eventually(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("a large non-HTML asset is streamed with exact bytes and length, and HEAD matches", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    mkdirSync(join(out, "assets"), { recursive: true });
    const asset = join(out, "assets", "large.bin");
    sparseAsset(asset, ASSET_SIZE);
    const expected = await digest(asset);
    assert.equal(expected.bytes, ASSET_SIZE);

    const before = process.memoryUsage().arrayBuffers;
    const reply = await download(server, "/assets/large.bin");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-type"], "application/octet-stream");
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.match(String(reply.headers["cache-control"] ?? ""), /no-store/);
    assert.equal(reply.headers["content-length"], String(ASSET_SIZE), "the exact length is advertised");
    assert.equal(reply.bytes, ASSET_SIZE, "every byte arrives");
    assert.equal(reply.hash, expected.hash, "the bytes are unchanged");
    assert.ok(
      reply.buffersAtHeaders - before < ASSET_SIZE / 2,
      `the response starts before the file is buffered; held ${reply.buffersAtHeaders - before} bytes of ${ASSET_SIZE}`,
    );

    const head = await download(server, "/assets/large.bin", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.bytes, 0, "HEAD sends no body");
    assert.equal(head.headers["content-length"], String(ASSET_SIZE), "HEAD advertises the GET length");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("HTML is still buffered for injection, with the client exactly once and an exact length", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.equal(html.split(RELOAD_MARKER).length - 1, 1, "the reload client appears exactly once");
    assert.equal(page.headers.get("content-length"), String(Buffer.byteLength(html)), "the injected length is exact");

    const head = await download(server, "/", "HEAD");
    assert.equal(head.bytes, 0);
    assert.equal(head.headers["content-length"], page.headers.get("content-length"), "HEAD matches the injected length");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a disconnect mid-download closes the file handle and leaves the server usable", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    mkdirSync(join(out, "assets"), { recursive: true });
    const asset = join(out, "assets", "large.bin");
    sparseAsset(asset, ASSET_SIZE);
    const before = openOn(asset);

    const head = await download(server, "/assets/large.bin", "HEAD");
    assert.equal(head.status, 200);
    assert.ok(await eventually(() => openOn(asset) === before), "HEAD closes the handle");

    const stalled = await stalledDownload(server, "/assets/large.bin");
    assert.ok(await eventually(() => openOn(asset) > before), "the download holds its handle while the client stalls");
    stalled.res.destroy();
    stalled.req.destroy();
    assert.ok(await eventually(() => openOn(asset) === before), "an early disconnect closes the handle");

    const again = await download(server, "/");
    assert.equal(again.status, 200, "the server still answers after a dropped download");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("shutdown cuts a stalled download instead of waiting for a client that stopped reading", async () => {
  const root = tree({ "mizzen.yml": CONFIG, "index.md": "# Home\n" });
  const { parent, out } = scratch();
  const server = await dev({ root, out, themeRoot: THEME, port: 0 });
  try {
    mkdirSync(join(out, "assets"), { recursive: true });
    const asset = join(out, "assets", "large.bin");
    sparseAsset(asset, ASSET_SIZE);
    const before = openOn(asset);

    const stalled = await stalledDownload(server, "/assets/large.bin");
    assert.ok(await eventually(() => openOn(asset) > before), "the download is in flight");

    let timer: NodeJS.Timeout | undefined;
    const limited = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 10_000);
      timer.unref();
    });
    const closed = await Promise.race([server.close().then(() => true), limited]);
    clearTimeout(timer);
    assert.ok(closed, "close resolves while a client has stopped reading");
    assert.ok(await eventually(() => openOn(asset) === before), "shutdown closes the file handle");

    stalled.res.destroy();
    stalled.req.destroy();
    await assert.rejects(download(server, "/assets/large.bin"), "nothing is served after close");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
