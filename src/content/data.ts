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

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A data file: `.yml`, `.yaml`, or `.json`, never case-sensitive, like discovery's file rules. */
const DATA_FILE = /\.(yml|yaml|json)$/i;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Data records stay ordinary mappings, so `Site.data` keeps the shape consumers already read; what makes them
// safe is that every key of a path below is read and written as an OWN property. A bare `node[key] = value` with
// a key of `__proto__` hits the legacy accessor on `Object.prototype` and swaps the record's prototype for the
// data instead of storing it, so the entry vanishes from the tree and its keys leak in as inherited values; a
// bare `node[key]` read of `__proto__` answers `Object.prototype` itself, which would then merge into the tree
// as if a previous file had loaded it. `prototype` and `constructor` are read the same way: only owned keys
// count as previously loaded data.

/** Whether the record owns `key`, never consulting the prototype chain. */
function owns(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The previously loaded data at `key`, or `undefined` when the record does not own that key. */
function ownValue(record: Mapping, key: string): unknown {
  return owns(record, key) ? record[key] : undefined;
}

/** Stores `value` as an own enumerable data property, bypassing any inherited accessor such as `__proto__`. */
function setOwn(record: Mapping, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A fresh record holding exactly the own enumerable keys of `source`, in the same order. */
function ownCopy(source: Mapping): Mapping {
  const copy: Mapping = {};
  for (const key of Object.keys(source)) setOwn(copy, key, source[key]);
  return copy;
}

/** The merged mapping of two loaded values: every own key of `later` wins, as the path sorting later always did. */
function mergeMappings(earlier: Mapping, later: Mapping): Mapping {
  const merged = ownCopy(earlier);
  for (const key of Object.keys(later)) setOwn(merged, key, later[key]);
  return merged;
}

/**
 * Sets `keys` to `value` in the tree. Two files that map to the same key merge when both values are mappings
 * (the path that sorts later wins each key); a folder's keys merge into a same-named file's mapping. Every key
 * of the path, special ones like `__proto__` included, is stored as an own property of the record above it.
 */
function insert(node: Mapping, keys: readonly string[], value: unknown): void {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const prev = ownValue(node, key);
    if (i === keys.length - 1) {
      setOwn(node, key, isMapping(prev) && isMapping(value) ? mergeMappings(prev, value) : value);
    } else {
      const next: Mapping = isMapping(prev) ? ownCopy(prev) : {};
      setOwn(node, key, next);
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
 * order, so runs are deterministic.
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
