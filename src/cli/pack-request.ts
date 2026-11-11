/**
 * Reads and validates the `ContextRequest` a caller passes to `mizzen pack --request <file|->`.
 *
 * The request is JSON, never YAML: a file is read as UTF-8 and `JSON.parse` decides whether it is well
 * formed. A schema or cross-field problem comes from {@link parseContextRequest} in `../packs/task.ts`.
 * Every problem is returned as one line so the CLI can write them all to stderr before it touches the
 * site, and a request that parses needs neither a theme nor `_data/context-packs.yml`.
 *
 * Standard input is consumed as a stream and is not closed by this module: the CLI may share the
 * process's stdin with the caller, so the last byte is read and the stream is left as the caller had it.
 */
import { readFile } from "node:fs/promises";
import type { ContextRequest } from "../contracts/context-request.ts";
import { parseContextRequest } from "../packs/task.ts";

/** The request read from a file or stdin, or every reason it cannot be used. */
export type ContextRequestRead =
  | { readonly request: ContextRequest }
  | { readonly problems: readonly string[] };

/** How {@link readContextRequest} reads standard input. */
export interface ReadRequestOptions {
  /** Reads stdin to its end; the CLI passes {@link readStandardInput}. */
  readonly stdin: () => Promise<string>;
}

/** Reads an async stream to its end without ending or destroying it. */
export async function readStandardInput(
  stream: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A short name for a problem's source: the path, or `stdin` for `-`. */
function sourceName(source: string): string {
  return source === "-" ? "stdin" : source;
}

/** The message of an unknown error, for a line a person reads. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads a request from `source`, where `-` means standard input, and validates it.
 *
 * The returned problems are one line each, in the request's order. A malformed document reports the
 * JSON parser's message; a valid document reports every schema or cross-field problem with its JSON
 * Pointer and stable code, so an agent can fix all of them in one pass.
 */
export async function readContextRequest(
  source: string,
  options: ReadRequestOptions,
): Promise<ContextRequestRead> {
  const name = sourceName(source);
  let text: string;
  try {
    text = source === "-" ? await options.stdin() : await readFile(source, "utf8");
  } catch (err) {
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
