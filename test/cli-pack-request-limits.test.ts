/**
 * Issue #112: the encoded `ContextRequest` a caller passes to `mizzen pack --request <file|->` is bounded
 * while it is read, not after it is parsed.
 *
 * These tests pin what the issue asks for: an oversized file or stream produces exactly one size problem and
 * never reaches `JSON.parse`; a request of exactly {@link MAX_REQUEST_BYTES} still parses; the limit counts
 * UTF-8 bytes rather than UTF-16 units; an oversized stream leaves bounded retained bytes; and the caller's
 * standard input is neither destroyed nor closed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ContextRequest } from "../src/contracts/context-request.ts";
import { main } from "../src/cli/index.ts";
import {
  MAX_REQUEST_BYTES,
  readContextRequest,
  readStandardInput,
  RequestTooLargeError,
  type ContextRequestRead,
} from "../src/cli/pack-request.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-pack-request-limits-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The bytes of `text` once encoded as UTF-8 — the unit the limit counts. */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A minimal valid request whose only free text is one include hint. */
function encodedRequest(pad: string): string {
  return JSON.stringify({
    version: 1,
    task: { goal: "install the engine" },
    budget: { maxTokens: 6000 },
    include: [pad],
  });
}

/** A valid request of exactly `bytes` UTF-8 bytes, filled with `unit` and topped up with ASCII. */
function requestOfExactly(bytes: number, unit = "x"): string {
  const room = bytes - bytesOf(encodedRequest(""));
  assert.ok(room >= 0, "the fixture has room for a hint");
  const pad = unit.repeat(Math.floor(room / bytesOf(unit)));
  const text = encodedRequest(`${pad}${"x".repeat(Math.max(0, bytes - bytesOf(encodedRequest(pad))))}`);
  assert.equal(bytesOf(text), bytes, `the fixture is exactly ${bytes} UTF-8 bytes`);
  return text;
}

/** `totalBytes` of input cut into `chunkBytes` pieces; a multibyte `unit` gets split across them. */
function byteChunks(totalBytes: number, chunkBytes: number, unit = "x"): Uint8Array[] {
  const filled = Buffer.alloc(totalBytes, unit, "utf8");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < filled.byteLength; offset += chunkBytes) {
    chunks.push(filled.subarray(offset, Math.min(offset + chunkBytes, filled.byteLength)));
  }
  return chunks;
}

/** An async stream of `chunks` that records every byte the reader actually pulled. */
function countedStream(chunks: readonly Uint8Array[], pulled: { bytes: number }): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<Uint8Array, undefined>> {
          const chunk = chunks[index];
          if (chunk === undefined) return { done: true, value: undefined };
          index += 1;
          pulled.bytes += chunk.byteLength;
          return { done: false, value: chunk };
        },
      };
    },
  };
}

/** A stream of string chunks, the shape a text-mode stdin yields. */
function stringStream(texts: readonly string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (const text of texts) yield text;
    },
  };
}

function onlyRequest(read: ContextRequestRead): ContextRequest {
  if ("request" in read) return read.request;
  throw new assert.AssertionError({ message: `expected a parsed request, got ${JSON.stringify(read.problems)}` });
}

function onlyProblems(read: ContextRequestRead): readonly string[] {
  if ("problems" in read) return read.problems;
  throw new assert.AssertionError({ message: `expected problems, got ${JSON.stringify(read.request)}` });
}

test("the limit is one documented size, far above any request a person writes", () => {
  assert.equal(MAX_REQUEST_BYTES, 1024 * 1024);
});

test("a stdin stream over the limit stops at the limit instead of reading the whole stream", async () => {
  // 32 MiB in 8 KiB pieces: a reader that kept every chunk would hold 32 MiB before it answered.
  const total = 32 * 1024 * 1024;
  const pulled = { bytes: 0 };
  await assert.rejects(
    () => readStandardInput(countedStream(byteChunks(total, 8192), pulled)),
    (err: unknown) => err instanceof RequestTooLargeError && err.limit === MAX_REQUEST_BYTES,
  );
  assert.ok(pulled.bytes <= MAX_REQUEST_BYTES + 8192, `the read stopped after ${pulled.bytes} bytes`);
  assert.ok(pulled.bytes < total, "the bytes past the limit were never pulled");
});

test("oversized stdin leaves the caller's stream open and unread to its end", async () => {
  const stream = new Readable({ read() {}, autoDestroy: false });
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < MAX_REQUEST_BYTES / chunk.length + 4; index += 1) stream.push(chunk);
  await assert.rejects(() => readStandardInput(stream), RequestTooLargeError);
  assert.equal(stream.destroyed, false, "the reader neither destroys nor closes the caller's stream");
  assert.equal(stream.readableEnded, false, "the read stopped at the limit, before the end of the stream");
  stream.destroy();
});

test("an oversized file reports one size problem and never reaches the JSON parser", async () => {
  const root = tree({});
  const path = join(root, "oversized.json");
  // Not JSON at all: a size problem proves the bytes were refused before JSON.parse saw them.
  writeFileSync(path, `{not json ${"y".repeat(MAX_REQUEST_BYTES)}`);
  try {
    const problems = onlyProblems(await readContextRequest(path, { stdin: async () => "" }));
    assert.equal(problems.length, 1, "exactly one problem line");
    assert.match(problems[0]!, /context-request\.too-large/);
    assert.match(problems[0]!, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(problems.join("\n"), /not valid JSON/, "the parser never ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a request of exactly the limit parses; one byte more is refused", async () => {
  const root = tree({});
  const atLimit = join(root, "at-limit.json");
  const overLimit = join(root, "over-limit.json");
  writeFileSync(atLimit, requestOfExactly(MAX_REQUEST_BYTES), "utf8");
  writeFileSync(overLimit, requestOfExactly(MAX_REQUEST_BYTES + 1), "utf8");
  try {
    const file = onlyRequest(await readContextRequest(atLimit, { stdin: async () => "" }));
    assert.equal(file.version, 1);
    assert.equal(file.budget.maxTokens, 6000);

    const text = readFileSync(atLimit, "utf8");
    const stdin = onlyRequest(await readContextRequest("-", { stdin: async () => text }));
    assert.equal(stdin.task.goal, "install the engine");

    const problems = onlyProblems(await readContextRequest(overLimit, { stdin: async () => "" }));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /context-request\.too-large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the limit counts UTF-8 bytes, not UTF-16 units", async () => {
  // Persian is three bytes per character, so the same request is short in units and long in bytes.
  const multibyte = requestOfExactly(MAX_REQUEST_BYTES + 1, "آ");
  assert.ok(multibyte.length < MAX_REQUEST_BYTES, "under the limit as UTF-16 units");
  assert.ok(bytesOf(multibyte) > MAX_REQUEST_BYTES, "over the limit as UTF-8 bytes");

  const root = tree({});
  const path = join(root, "multibyte.json");
  writeFileSync(path, multibyte, "utf8");
  try {
    const file = onlyProblems(await readContextRequest(path, { stdin: async () => "" }));
    assert.equal(file.length, 1);
    assert.match(file[0]!, /context-request\.too-large/);

    const stdin = onlyProblems(await readContextRequest("-", { stdin: async () => multibyte }));
    assert.match(stdin[0]!, /context-request\.too-large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multibyte characters split across chunks are counted by bytes and decoded whole", async () => {
  const text = JSON.stringify({ version: 1, task: { goal: "نصب موتور" }, budget: { maxTokens: 6000 } });
  const size = Buffer.from(text, "utf8").byteLength;
  const oneByteChunks = [...Buffer.from(text, "utf8")].map((byte) => Buffer.from([byte]));
  const pulled = { bytes: 0 };
  const read = await readStandardInput(countedStream(oneByteChunks, pulled), size);
  assert.equal(read, text, "every continuation byte arrived in its own chunk");
  assert.equal(pulled.bytes, size);
  const request = onlyRequest(
    await readContextRequest("-", { stdin: () => readStandardInput(stringStream([read]), size) }),
  );
  assert.equal(request.task.goal, "نصب موتور", "the decoded text is the request the reader was given");

  await assert.rejects(
    () => readStandardInput(stringStream([text, "نصب"]), size - 3),
    RequestTooLargeError,
    "one UTF-8 byte past the limit is refused",
  );
});

test("the CLI exits 2 with one size problem on stderr and an empty stdout", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": "# Install\n\nInstall the engine.\n" });
  const path = join(root, "request.json");
  writeFileSync(path, `{not json ${"y".repeat(MAX_REQUEST_BYTES)}`);
  try {
    const writes: string[] = [];
    const errors: string[] = [];
    assert.equal(
      await main(["pack", root, "--request", "-"], {
        write: (text: string) => void writes.push(text),
        error: (message: string) => void errors.push(message),
        log: (message: string) => void errors.push(message),
        readStdin: async () => "x".repeat(MAX_REQUEST_BYTES + 1),
      }),
      2,
    );
    assert.deepEqual(writes, [], "stdout stays a clean document");
    assert.equal(errors.length, 1, "one size problem, not a cascade");
    assert.match(errors[0]!, /^mizzen: .*context-request\.too-large/);
    assert.doesNotMatch(errors.join("\n"), /not valid JSON/);

    const fileWrites: string[] = [];
    const fileErrors: string[] = [];
    assert.equal(
      await main(["pack", root, "--request", path, "--format", "json"], {
        write: (text: string) => void fileWrites.push(text),
        error: (message: string) => void fileErrors.push(message),
        log: (message: string) => void fileErrors.push(message),
      }),
      2,
    );
    assert.deepEqual(fileWrites, []);
    assert.equal(fileErrors.length, 1);
    assert.match(fileErrors[0]!, /context-request\.too-large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
