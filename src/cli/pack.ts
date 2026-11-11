/**
 * `mizzen pack <dir> [--request <file|->] [--topic <name>] [--budget <tokens>] [--format markdown|json] [--out <file>]`:
 * build one context pack on demand.
 *
 * A pack is either the Markdown the `context-pack` output writes to `pack/<topic>.md` (#1493), or the same selected
 * evidence as the `PackEvidence` JSON twin. The command reads the site model, never the theme, so it works without a
 * theme root. Without `--out` the pack goes to stdout, which keeps it usable in a pipe; with `--out` it is written
 * through a rename, so a reader never sees a half-written pack and stdout stays empty.
 *
 * A topic comes from `_data/context-packs.yml`. Without `--topic`, a site with one topic uses it; a site with
 * several lists them and exits 2. An unknown topic is a usage error. `--budget` overrides the topic's budget.
 *
 * `--request` reads a versioned `ContextRequest` from a JSON file, or stdin with `-`, and compiles it through
 * `../packs/compile.ts` instead: task goal, include/exclude hints, locale and version range, budget reservation,
 * and required evidence all apply. A request needs neither a theme nor `_data/context-packs.yml`. Every request
 * problem goes to stderr in one pass, and stdout stays empty. `--request` cannot be combined with `--topic` or
 * `--budget`, because the request carries its own budget.
 *
 * Diagnostics such as `context-pack.no-pages` and over-budget warnings go to stderr, so stdout stays a clean
 * document. `--format json` prints or writes the structured evidence instead of Markdown. Exit codes are the
 * CLI's: 0 ok, 1 no context or errors, 2 usage.
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextRequest } from "../contracts/context-request.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { OutputContext } from "../contracts/output.ts";
import { buildModel } from "../model/build.ts";
import { compilePack } from "../packs/compile.ts";
import {
  buildPack,
  readPackTopic,
  readPackTopics,
  slugOf,
  type PackEvidence,
  type PackTopic,
} from "../outputs/context-pack.ts";
import { formatText } from "../pipeline/diagnostics.ts";
import { readContextRequest, readStandardInput } from "./pack-request.ts";

/** What `--format` prints: the Markdown pack, or its structured evidence. */
export type PackFormat = "markdown" | "json";

/** Options of {@link pack}. */
export interface PackOptions {
  /** The site root, the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** A topic name or slug; defaults to the site's only topic. */
  readonly topic?: string;
  /** A positive token budget that overrides the topic's own. */
  readonly budget?: number;
  /** A JSON context request, or `-` for stdin; when set, the topic path is not read. */
  readonly request?: string;
  /** The payload: Markdown (default) or the structured `PackEvidence`. */
  readonly format?: PackFormat;
  /** A file to write the pack to, resolved by the caller; stdout when absent. */
  readonly out?: string;
}

/** Where {@link pack} writes: the pack itself, and anything for a person to read. */
export interface PackIo {
  /** Writes the pack to stdout. */
  readonly write: (text: string) => void;
  /** Writes diagnostics and errors to stderr. */
  readonly error: (message: string) => void;
  /** Reads stdin for `--request -`; defaults to consuming the process's stream without closing it. */
  readonly readStdin?: () => Promise<string>;
}

/** Compares names by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a `--topic` value names this topic: exactly, case-insensitively, or by its file slug. */
function matchesTopic(topic: PackTopic, request: string): boolean {
  if (topic.topic === request) return true;
  if (topic.topic.toLowerCase() === request.toLowerCase()) return true;
  const slug = slugOf(topic.topic);
  return slug !== "" && slug === slugOf(request);
}

/** Prints diagnostics to stderr, never to the pack's stdout. */
function reportDiagnostics(diagnostics: readonly Diagnostic[], error: (message: string) => void): void {
  if (diagnostics.length === 0) return;
  error(formatText(diagnostics).replace(/\n$/, ""));
}

/** The topic names, sorted by code point, for a list or an error message. */
function topicNames(topics: readonly PackTopic[]): readonly string[] {
  return topics.map((topic) => topic.topic).sort(byCodePoint);
}

/** Writes a file through a staging folder and a rename, so no reader sees a partial pack. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(join(folder, ".mizzen-pack-"));
  try {
    const temp = join(staging, "payload");
    await writeFile(temp, contents, "utf8");
    await rename(temp, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Prints the chosen payload to stdout, or writes it atomically to `--out`. */
async function emit(
  markdown: string,
  evidence: PackEvidence,
  options: PackOptions,
  io: PackIo,
): Promise<void> {
  const text = options.format === "json" ? `${JSON.stringify(evidence, null, 2)}\n` : markdown;
  if (options.out !== undefined) {
    await writeAtomic(options.out, text);
  } else {
    io.write(text);
  }
}

/** Reads and validates `--request`, reporting every problem to stderr instead of throwing. */
async function readRequest(
  options: PackOptions,
  io: PackIo,
): Promise<{ readonly ok: true; readonly request: ContextRequest } | { readonly ok: false }> {
  const source = options.request;
  if (source === undefined) return { ok: false };
  const read = await readContextRequest(source, { stdin: io.readStdin ?? readStandardInput });
  if ("problems" in read) {
    for (const problem of read.problems) io.error(`mizzen: ${problem}`);
    return { ok: false };
  }
  return { ok: true, request: read.request };
}

/**
 * Builds one context pack and writes it to stdout or `--out`. Returns the CLI exit code.
 *
 * The same site gives the same bytes: the model is deterministic, ranking and trimming are pure, and nothing here
 * reads the clock, the network, or the environment.
 */
export async function pack(options: PackOptions, io: PackIo): Promise<number> {
  const requested = await readRequest(options, io);
  if (options.request !== undefined && !requested.ok) return 2;

  const model = await buildModel(options.root);
  const modelErrors = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (modelErrors.length > 0) {
    reportDiagnostics(modelErrors, io.error);
    return 1;
  }

  const diagnostics: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("pack builds no pages")),
    report: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };
  const site = model.site;

  if (requested.ok) {
    const compiled = await compilePack(site, requested.request, ctx, { warnings: model.diagnostics });
    reportDiagnostics(diagnostics, io.error);
    if (compiled === undefined) {
      io.error("mizzen: the request selected no context; nothing was written.");
      return 1;
    }
    await emit(compiled.markdown, compiled.evidence, options, io);
    return 0;
  }

  const raw = readPackTopics(site, ctx);
  if (raw === undefined) {
    reportDiagnostics(diagnostics, io.error);
    io.error(
      "mizzen: no context pack topics: add `_data/context-packs.yml` with at least one `- topic: <name>` entry.",
    );
    return 2;
  }

  const topics: PackTopic[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const topic = readPackTopic(raw[index], index + 1, ctx);
    if (topic !== undefined) topics.push(topic);
  }
  if (topics.length === 0) {
    reportDiagnostics(diagnostics, io.error);
    io.error("mizzen: no context pack topics: `_data/context-packs.yml` defines none that can be used.");
    return 2;
  }

  const names = topicNames(topics);
  let selected: PackTopic;
  if (options.topic === undefined) {
    if (topics.length > 1) {
      io.error(
        `mizzen: --topic is required: \`_data/context-packs.yml\` defines ${topics.length} topics:\n${names
          .map((name) => `  - ${name}`)
          .join("\n")}`,
      );
      return 2;
    }
    selected = topics[0]!;
  } else {
    const request = options.topic.trim();
    const matches = topics.filter((topic) => matchesTopic(topic, request));
    if (matches.length === 0) {
      io.error(`mizzen: unknown topic: ${request}; available topics: ${names.join(", ")}`);
      return 2;
    }
    if (matches.length > 1) {
      io.error(`mizzen: topic ${request} is ambiguous: ${topicNames(matches).join(", ")}`);
      return 2;
    }
    selected = matches[0]!;
  }

  const topic: PackTopic = options.budget === undefined ? selected : { ...selected, budget: options.budget };
  const built = await buildPack(site, topic, ctx);
  if (built === undefined) {
    reportDiagnostics(diagnostics, io.error);
    io.error(`mizzen: no pages match the topic ${topic.topic}.`);
    return 1;
  }
  reportDiagnostics(diagnostics, io.error);

  await emit(built.contents, built.evidence, options, io);
  return 0;
}
