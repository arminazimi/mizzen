import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleName } from "../runtime/modules.ts";
import type { Diagnostic, Page, Site, SiteConfig, SourcePos } from "../contracts/index.ts";

/** What a fact receives when it runs: the site root, its content folder, the config, the final pages, and `_data`. */
export interface FactContext {
  /** The site root, absolute. */
  readonly root: string;
  /** The content folder, absolute. */
  readonly sourceDir: string;
  /** The site config. */
  readonly config: SiteConfig;
  /** Every page, in the model's final sorted order. */
  readonly pages: readonly Page[];
  /** The files loaded from `_data/`, before any fact runs. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * One derived fact: a value computed from the site model during the model stage and merged into `Site.data` under
 * {@link Fact.name}. A fact lives in its own file in `facts/`, so adding one edits no shared index.
 */
export interface Fact {
  /** The key in `Site.data`; must equal the file name without its extension. */
  readonly name: string;
  /** Computes the value. A returned `undefined` is treated as no value. */
  compute(ctx: FactContext): unknown | Promise<unknown>;
}

/** What {@link loadFacts} found: the valid units, in file-name order, and every finding. */
export interface LoadFactsResult {
  /** The valid facts, sorted by file name (code points). */
  readonly facts: readonly Fact[];
  /** Units that could not be imported or do not have the shape or name a fact needs. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link applyFacts}. */
export interface ApplyFactsOptions {
  /** The model assembled so far; its `data` is `_data`, the record facts are merged into. */
  readonly site: Site;
  /** The site root. Absolute paths are kept; a relative path is resolved against the working directory. */
  readonly root: string;
  /** The content folder. Absolute paths are kept; a relative path is resolved against the working directory. */
  readonly sourceDir: string;
  /** Folder of fact files. Default: `facts/` beside this file. Tests pass a temporary folder. */
  readonly dir?: string;
}

/** What {@link applyFacts} returns. */
export interface ApplyFactsResult {
  /** The site with each derived value at `data[fact.name]`; `_data` keeps every key it already had. */
  readonly site: Site;
  /** Findings from loading and running the facts, in that order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The default folder of facts: `facts/` beside this file. */
const FACTS_DIR = fileURLToPath(new URL("./facts/", import.meta.url));

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for the shape a fact export must have. */
function isFact(value: unknown): value is Fact {
  if (typeof value !== "object" || value === null) return false;
  const { name, compute } = value as { name?: unknown; compute?: unknown };
  return typeof name === "string" && typeof compute === "function";
}

/** A position at the start of a fact file, so a diagnostic names the unit. */
function atFile(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * Reads every `*.ts` file of `dir` in file-name order and returns the facts they export. A file must export exactly
 * one object with a string `name` and a `compute` function, and `name` must equal the file name without its extension.
 * A file that cannot be imported, exports no fact, exports more than one, or is named differently is left out with a
 * `facts.load-failed` error; the other files still load. A missing folder is the same error.
 */
export async function loadFacts(dir?: string): Promise<LoadFactsResult> {
  const folder = resolve(dir ?? FACTS_DIR);
  const diagnostics: Diagnostic[] = [];
  const facts: Fact[] = [];

  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && moduleName(entry.name) !== null)
      .map((entry) => entry.name)
      .sort(byCodePoint);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      id: "facts.load-failed",
      severity: "error",
      message: `Cannot read the facts folder "${folder}": ${detail}.`,
      help: "Point the facts folder at a folder of fact files.",
    });
    return { facts, diagnostics };
  }

  for (const file of names) {
    const path = join(folder, file);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        id: "facts.load-failed",
        severity: "error",
        message: `Failed to load fact "${file}": ${detail}.`,
        pos: atFile(path),
        help: "Fix the file so Node can import it.",
      });
      continue;
    }

    const found = Object.keys(mod)
      .sort(byCodePoint)
      .map((key) => mod[key])
      .filter(isFact);
    if (found.length === 0) {
      diagnostics.push({
        id: "facts.load-failed",
        severity: "error",
        message: `Fact file "${file}" exports no fact.`,
        pos: atFile(path),
        help: "Export one object with a string `name` and a `compute` function.",
      });
      continue;
    }
    if (found.length > 1) {
      diagnostics.push({
        id: "facts.load-failed",
        severity: "error",
        message: `Fact file "${file}" exports ${found.length} facts; it may export one.`,
        pos: atFile(path),
        help: "Move the extra facts into their own files.",
      });
      continue;
    }
    const fact = found[0]!;
    const expected = moduleName(file)!;
    if (fact.name !== expected) {
      diagnostics.push({
        id: "facts.load-failed",
        severity: "error",
        message: `Fact file "${file}" is named "${fact.name}"; it must be "${expected}".`,
        pos: atFile(path),
        help: "Make the fact's name equal to its file name, without its extension.",
      });
      continue;
    }
    facts.push(fact);
  }

  return { facts, diagnostics };
}

/**
 * Runs every fact of `dir` in file-name order and merges each value into `Site.data` under its name. A key the site
 * already has in `_data` wins: the fact does not run and nothing is reported. A fact that throws, or returns
 * `undefined`, is left out with a `facts.compute-failed` warning and the other facts still run. The returned data has
 * its keys sorted by code point, so two runs on one input have the same key order. Facts do not
 * see each other's values: each receives the `_data` record.
 */
export async function applyFacts(options: ApplyFactsOptions): Promise<ApplyFactsResult> {
  const root = resolve(options.root);
  const sourceDir = resolve(options.sourceDir);
  const loaded = await loadFacts(options.dir);
  const diagnostics: Diagnostic[] = [...loaded.diagnostics];

  const data: Record<string, unknown> = Object.fromEntries(Object.entries(options.site.data));
  const ctx: FactContext = {
    root,
    sourceDir,
    config: options.site.config,
    pages: options.site.pages,
    data: options.site.data,
  };

  for (const fact of loaded.facts) {
    // The site's own `_data/<name>.yml` is the source of truth; a fact never replaces it and never reports the overlap.
    if (Object.hasOwn(options.site.data, fact.name)) continue;
    let value: unknown;
    try {
      value = await fact.compute(ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        id: "facts.compute-failed",
        severity: "warning",
        message: `Fact "${fact.name}" failed: ${detail}.`,
        pos: atFile(join(resolve(options.dir ?? FACTS_DIR), `${fact.name}.ts`)),
        help: "Fix the fact's compute function. The site builds without this value.",
      });
      continue;
    }
    if (value === undefined) {
      diagnostics.push({
        id: "facts.compute-failed",
        severity: "warning",
        message: `Fact "${fact.name}" returned no value.`,
        pos: atFile(join(resolve(options.dir ?? FACTS_DIR), `${fact.name}.ts`)),
        help: "Return a value, or remove the fact.",
      });
      continue;
    }
    data[fact.name] = value;
  }

  const sorted = Object.fromEntries(Object.keys(data).sort(byCodePoint).map((key) => [key, data[key]]));
  return { site: { ...options.site, data: sorted }, diagnostics };
}
