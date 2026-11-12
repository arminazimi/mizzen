/**
 * Reads and validates the `ContextRequest` a caller passes to `mizzen pack --request <file|->`.
 *
 * The request is JSON, never YAML: a file is read as UTF-8 and `JSON.parse` decides whether it is well
 * formed. A schema or cross-field problem comes from {@link parseContextRequest} in `../packs/task.ts`.
 * Every problem is returned as one line so the CLI can write them all to stderr before it touches the
 * site, and a request that parses needs neither a theme nor `_data/context-packs.yml`.
 *
 * Input is bounded before it is allocated. One documented limit, {@link MAX_REQUEST_BYTES}, counts encoded
 * UTF-8 bytes, and both readers stop at it: a file is streamed in pieces and standard input stops on the
 * chunk that passes the limit, so an accidental or hostile request can never exhaust the process. Bytes
 * past the limit are refused as one `context-request.too-large` problem and never reach `JSON.parse`; a
 * request of exactly the limit is still read. The bytes a reader retains stay at or below the limit, and
 * the caller's standard input is left neither destroyed nor closed, so the caller keeps what it did not read.
 *
 * Standard input is consumed as a stream and is not closed by this module: the CLI may share the
 * process's stdin with the caller, so the last byte is read and the stream is left as the caller had it.
 */
import { createReadStream } from "node:fs";
import type { ContextRequest } from "../contracts/context-request.ts";
import { parseContextRequest } from "../packs/task.ts";

/**
 * The largest encoded request this module reads, in UTF-8 bytes: 1 MiB.
 *
 * A request names pages and states one goal, so even a generous one is a few kilobytes; 1 MiB leaves room
 * for thousands of hints and still keeps the CLI's worst-case read far below the process's memory. It is
 * one constant on purpose: the same number guards a file, a stream, and the text a caller hands over.
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** Raised when input passes {@link MAX_REQUEST_BYTES}, before any of it is parsed. */
export class RequestTooLargeError extends Error {
  /** The byte limit the input passed. */
  readonly limit: number;

  constructor(limit: number = MAX_REQUEST_BYTES) {
    super(`the encoded request is larger than the ${limit}-byte limit`);
    this.name = "RequestTooLargeError";
    this.limit = limit;
  }
}

/** The request read from a file or stdin, or every reason it cannot be used. */
export type ContextRequestRead =
  | { readonly request: ContextRequest }
  | { readonly problems: readonly string[] };

/** How {@link readContextRequest} reads standard input. */
export interface ReadRequestOptions {
  /**
   * Reads stdin to its end, or to {@link MAX_REQUEST_BYTES}; the CLI passes {@link readStandardInput}.
   * A replacement that returns more than the limit is refused the same way.
   */
  readonly stdin: () => Promise<string>;
}

/**
 * Reads standard input as a stream, to its end or to `limit` bytes.
 *
 * The read stops on the chunk that passes the limit, so the bytes it keeps are bounded by that limit, and
 * it never calls the iterator's `return`, never closes, and never destroys the stream: `process.stdin`
 * belongs to the caller, which may still have the remaining bytes to read.
 */
export async function readStandardInput(
  stream: AsyncIterable<string | Uint8Array> = process.stdin,
  limit: number = MAX_REQUEST_BYTES,
): Promise<string> {
  return readCapped(stream, limit, false);
}

/** A short name for a problem's source: the path, or `stdin` for `-`. */
function sourceName(source: string): string {
  return source === "-" ? "stdin" : source;
}

/** The message of an unknown error, for a line a person reads. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One streamed piece as a Buffer, without copying bytes the caller already owns. */
function asBuffer(chunk: string | Uint8Array): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Reads at most `limit` UTF-8 bytes of `stream` as text, or throws {@link RequestTooLargeError}.
 *
 * Chunks are collected until the limit, so a whole multibyte character that spans two chunks decodes
 * exactly as the bytes did; nothing is decoded per chunk. Bytes are counted, never characters, so UTF-16
 * units cannot talk their way past the limit. `ownsStream` decides who releases the reader: a file this
 * module opened is finished with, a caller's standard input is left as it was found.
 */
async function readCapped(
  stream: AsyncIterable<string | Uint8Array>,
  limit: number,
  ownsStream: boolean,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    const chunk = asBuffer(step.value);
    bytes += chunk.byteLength;
    if (bytes > limit) {
      chunks.length = 0;
      if (ownsStream) await iterator.return?.();
      throw new RequestTooLargeError(limit);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

/** Reads a request file in bounded pieces, so an oversized file is refused without being allocated. */
async function readRequestFile(source: string, limit: number): Promise<string> {
  return readCapped(createReadStream(source), limit, true);
}

/** One line naming the limit and what to do about it, in the request's own diagnostic vocabulary. */
function sizeProblem(name: string, limit: number): string {
  return (
    `the request in ${name} is larger than ${limit} bytes: context-request.too-large: ` +
    `keep the encoded request within ${limit} UTF-8 bytes, for example by shortening the task goal ` +
    `and the include, exclude, and requiredEvidence lists`
  );
}

/**
 * Reads a request from `source`, where `-` means standard input, and validates it.
 *
 * Input over {@link MAX_REQUEST_BYTES} is refused as one size problem before the parser sees it; that is
 * the only limit the read applies. Within it, the returned problems are one line each, in the request's
 * order: a malformed document reports the JSON parser's message, and a valid document reports every schema
 * or cross-field problem with its JSON Pointer and stable code, so an agent can fix all of them in one pass.
 */
export async function readContextRequest(
  source: string,
  options: ReadRequestOptions,
): Promise<ContextRequestRead> {
  const name = sourceName(source);
  let text: string;
  try {
    text = source === "-" ? await options.stdin() : await readRequestFile(source, MAX_REQUEST_BYTES);
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new RequestTooLargeError(MAX_REQUEST_BYTES);
  } catch (err) {
    if (err instanceof RequestTooLargeError) return { problems: [sizeProblem(name, err.limit)] };
    return { problems: [`cannot read the request from ${name}: ${messageOf(err)}`] };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { problems: [`the request in ${name} is not valid JSON: ${messageOf(err)}`] };
  }

  const result = parseContextRequest(value);
  if (result.request !== undefined) return { request: result.request };
  return {
    problems: result.problems.map(
      (problem) => `${name} ${problem.path === "" ? "/" : problem.path}: ${problem.code}: ${problem.message}`,
    ),
  };
}
