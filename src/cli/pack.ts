/**
 * `mizzen pack <dir> [--topic <name>] [--budget <tokens>] [--out <file>]`: build one context pack on demand.
 *
 * A pack is the same Markdown the `context-pack` output writes to `pack/<topic>.md` (#1493): the pages that best
 * match a topic's query, trimmed to its token budget. The command reads the site model, never the theme, so it
 * works without a theme root. Without `--out` the pack goes to stdout, which keeps it usable in a pipe; with
 * `--out` it is written to that file and stdout stays empty.
 *
 * A topic comes from `_data/context-packs.yml`. Without `--topic`, a site with one topic uses it; a site with
 * several lists them and exits 2. An unknown topic is a usage error. `--budget` overrides the topic's budget.
 * Diagnostics such as `context-pack.no-pages` and the over-budget warning go to stderr, so stdout stays a clean
 * Markdown document. Exit codes are the CLI's: 0 ok, 1 errors, 2 usage.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { OutputContext } from "../contracts/output.ts";
import { buildModel } from "../model/build.ts";
import { buildPack, readPackTopic, readPackTopics, slugOf, type PackTopic } from "../outputs/context-pack.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Options of {@link pack}. */
export interface PackOptions {
  /** The site root, the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** A topic name or slug; defaults to the site's only topic. */
  readonly topic?: string;
  /** A positive token budget that overrides the topic's own. */
  readonly budget?: number;
  /** A file to write the pack to, resolved by the caller; stdout when absent. */
  readonly out?: string;
}

/** Where {@link pack} writes: the pack itself, and anything for a person to read. */
export interface PackIo {
  /** Writes the pack to stdout. */
  readonly write: (text: string) => void;
  /** Writes diagnostics and errors to stderr. */
  readonly error: (message: string) => void;
}

/** Compares names by code point, never by locale (ADR 0022, rule 5). */
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

/**
 * Builds one context pack and writes it to stdout or `--out`. Returns the CLI exit code.
 *
 * The same site gives the same bytes: the model is deterministic, ranking and trimming are pure, and nothing here
 * reads the clock, the network, or the environment.
 */
export async function pack(options: PackOptions, io: PackIo): Promise<number> {
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

  if (options.out !== undefined) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, built.contents, "utf8");
  } else {
    io.write(built.contents);
  }
  return 0;
}
