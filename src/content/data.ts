import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Diagnostic } from "../contracts/index.ts";
import type { DiscoveredFile } from "./discover.ts";

/** What {@link loadData} read from `_data`. */
export interface DataResult {
  /** The loaded data files for `Site.data`, keyed by file name without extension; nested folders are nested keys. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Parse problems, each with the line; empty when every file parsed. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A data file: `.yml`, `.yaml`, or `.json`, never case-sensitive, like discovery's file rules. */
const DATA_FILE = /\.(yml|yaml|json)$/i;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sets `keys` to `value` in the tree. Two files that map to the same key merge when both values are mappings
 * (the path that sorts later wins each key); a folder's keys merge into a same-named file's mapping.
 */
function insert(node: Mapping, keys: readonly string[], value: unknown): void {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const prev = node[key];
    if (i === keys.length - 1) {
      node[key] = isMapping(prev) && isMapping(value) ? { ...prev, ...value } : value;
    } else {
      const next: Mapping = isMapping(prev) ? { ...prev } : {};
      node[key] = next;
      node = next;
    }
  }
}

/** The mapping keys of a data file path: `_data/guides/steps.yml` becomes `["guides", "steps"]`. */
function keysOf(path: string): string[] {
  return path
    .slice("_data/".length)
    .replace(/\.[^.]+$/, "")
    .split("/")
    .filter((key) => key !== "");
}

function yamlDiagnostic(error: { message: string; linePos?: readonly { line: number; col: number }[] | null }, rel: string): Diagnostic {
  const start = error.linePos?.[0];
  const end = error.linePos?.[1] ?? start;
  return {
    id: "data.invalid-yaml",
    severity: "error",
    message: `Invalid YAML in data file: ${error.message.split("\n")[0]}`,
    pos: {
      file: rel,
      line: start?.line ?? 1,
      column: start?.col ?? 1,
      endLine: end?.line ?? start?.line ?? 1,
      endColumn: end?.col ?? start?.col ?? 1,
    },
  };
}

function jsonDiagnostic(cause: unknown, text: string, rel: string): Diagnostic {
  const message = cause instanceof Error ? cause.message.split("\n")[0] ?? "" : "Invalid JSON.";
  let line = 1;
  let column = 1;
  const at = /\(line (\d+) column (\d+)\)/.exec(message);
  if (at) {
    line = Number(at[1]);
    column = Number(at[2]);
  } else {
    const offset = /\bposition (\d+)/i.exec(message);
    if (offset) {
      const before = text.slice(0, Number(offset[1]));
      line = before.split("\n").length;
      column = before.length - (before.lastIndexOf("\n") + 1) + 1;
    }
  }
  return {
    id: "data.invalid-json",
    severity: "error",
    message: `Invalid JSON in data file: ${message}`,
    pos: { file: rel, line, column, endLine: line, endColumn: column },
  };
}

async function parseOne(abs: string, rel: string): Promise<{ value?: unknown; diagnostics: readonly Diagnostic[] }> {
  const text = (await readFile(abs, "utf8")).replace(/^﻿/, "");
  if (/\.json$/i.test(rel)) {
    try {
      return { value: JSON.parse(text) as unknown, diagnostics: [] };
    } catch (cause) {
      return { diagnostics: [jsonDiagnostic(cause, text, rel)] };
    }
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { diagnostics: doc.errors.map((error) => yamlDiagnostic(error, rel)) };
  }
  return { value: doc.toJS() ?? {}, diagnostics: [] };
}

/**
 * Loads every YAML and JSON data file discovery found under `_data` into one record for `Site.data`, keyed by
 * file name without extension; nested folders become nested keys, so `_data/guides/steps.yml` lands at
 * `data.guides.steps`. Other files under `_data` are ignored. A file that fails to parse is left out and every
 * other file still loads. A missing or empty `_data` folder is not an error. Paths are processed in code-point
 * order, so runs are deterministic (ADR 0022, rule 5).
 */
export async function loadData(source: string, files: readonly DiscoveredFile[]): Promise<DataResult> {
  const diagnostics: Diagnostic[] = [];
  const data: Record<string, unknown> = {};

  const sorted = [...files].sort((a, b) => byCodePoint(a.path, b.path));
  for (const file of sorted) {
    if (file.kind !== "data") continue;
    const rel = file.path.replace(/\\/g, "/");
    if (!DATA_FILE.test(rel)) continue;
    const parsed = await parseOne(join(source, rel), rel);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined) insert(data, keysOf(rel), parsed.value);
  }

  return { data, diagnostics };
}
