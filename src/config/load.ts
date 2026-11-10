import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative } from "node:path";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
  type Pair,
} from "yaml";
import type {
  DefaultsEntry,
  Diagnostic,
  Direction,
  LanguageConfig,
  RepositoryConfig,
  SearchConfig,
  SiteConfig,
  SourcePos,
  ThemeConfig,
} from "../contracts/index.ts";

/** The site config file name (ADR 0025). */
export const CONFIG_FILE = "mizzen.yml";

/** Result of loading a site's config. */
export interface LoadConfigResult {
  /** The config after defaults; always complete even when diagnostics are present. */
  readonly config: SiteConfig;
  /** Problems found in the file; empty when the file is missing or valid. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Absolute or site-relative path of the config file. Default: `<siteRoot>/mizzen.yml`. */
  readonly path?: string;
}

/** Primary language subtags that default to right-to-left (same list as the 0.2 theme). */
const RTL = new Set([
  "ar", "arc", "ckb", "dv", "fa", "he", "ks", "ku", "ps", "sd", "syr", "ug", "ur", "yi",
]);

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/config.schema.json", import.meta.url), "utf8"),
) as object;
const validateConfig = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Default text direction for a BCP 47 tag. */
export function directionFromLang(lang: string): Direction {
  const base = lang.split("-", 1)[0]?.toLowerCase() ?? "";
  return RTL.has(base) ? "rtl" : "ltr";
}

/**
 * Load `mizzen.yml` from `siteRoot` (or `options.path`), validate it, and fill defaults.
 * A missing file yields the defaults and the folder name as `title`, with no diagnostic.
 */
export function loadConfig(siteRoot: string, options: LoadConfigOptions = {}): LoadConfigResult {
  const absPath = options.path === undefined ? join(siteRoot, CONFIG_FILE) : options.path;
  const file = posixRelative(siteRoot, absPath);
  const folderTitle = basename(siteRoot);

  if (!existsSync(absPath)) {
    return { config: applyDefaults({}, folderTitle), diagnostics: [] };
  }

  const text = readFileSync(absPath, "utf8");
  return loadConfigText(text, file, folderTitle);
}

/** Parse and validate config YAML text. `file` is only used for diagnostic positions. */
export function loadConfigText(source: string, file: string, folderTitle: string): LoadConfigResult {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const diagnostics: Diagnostic[] = [];

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      const end = error.linePos?.[1] ?? start;
      diagnostics.push({
        id: "config.invalid-yaml",
        severity: "error",
        message: `Invalid YAML in ${file}: ${error.message.split("\n")[0]}`,
        pos: {
          file,
          line: start?.line ?? 1,
          column: start?.col ?? 1,
          endLine: end?.line ?? start?.line ?? 1,
          endColumn: end?.col ?? start?.col ?? 1,
        },
      });
    }
    return { config: applyDefaults({}, folderTitle), diagnostics };
  }

  const value: unknown = doc.toJS();
  if (value === null || value === undefined) {
    return { config: applyDefaults({}, folderTitle), diagnostics: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      config: applyDefaults({}, folderTitle),
      diagnostics: [{
        id: "config.not-a-mapping",
        severity: "error",
        message: "Site config must be a YAML mapping of keys to values.",
        pos: posFromNode(file, lineCounter, doc.contents),
      }],
    };
  }

  const raw = value as Record<string, unknown>;
  if (!validateConfig(raw) && validateConfig.errors) {
    for (const error of validateConfig.errors) {
      diagnostics.push(diagnosticFromAjv(error, file, doc, lineCounter));
    }
  }

  return { config: applyDefaults(raw, folderTitle), diagnostics };
}

function applyDefaults(raw: Record<string, unknown>, folderTitle: string): SiteConfig {
  const lang = typeof raw.lang === "string" && raw.lang.length >= 2 ? raw.lang : "en";
  const dir: Direction =
    raw.dir === "ltr" || raw.dir === "rtl" ? raw.dir : directionFromLang(lang);

  const repository = repositoryFrom(raw.repository);
  const search = searchFrom(raw.search);
  const theme: ThemeConfig = isPlainObject(raw.theme) ? (raw.theme as ThemeConfig) : {};

  return {
    title: typeof raw.title === "string" ? raw.title : folderTitle,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    base: typeof raw.base === "string" ? raw.base : "",
    lang,
    dir,
    languages: Array.isArray(raw.languages) ? (raw.languages as LanguageConfig[]) : [],
    source: typeof raw.source === "string" && raw.source.length > 0 ? raw.source : ".",
    include: Array.isArray(raw.include) ? (raw.include as string[]) : [],
    exclude: Array.isArray(raw.exclude) ? (raw.exclude as string[]) : [],
    navigation:
      typeof raw.navigation === "string" && raw.navigation.length > 0
        ? raw.navigation
        : "_data/navigation.yml",
    defaults: Array.isArray(raw.defaults) ? (raw.defaults as DefaultsEntry[]) : [],
    ...(repository === undefined ? {} : { repository }),
    theme,
    search,
    redirects: isPlainObject(raw.redirects) ? (raw.redirects as Record<string, string>) : {},
    outputs: isPlainObject(raw.outputs) ? (raw.outputs as Record<string, boolean>) : {},
  };
}

function repositoryFrom(value: unknown): RepositoryConfig | undefined {
  if (!isPlainObject(value) || typeof value.url !== "string") return undefined;
  return {
    url: value.url,
    branch: typeof value.branch === "string" && value.branch.length > 0 ? value.branch : "main",
    dir: typeof value.dir === "string" ? value.dir : "",
  };
}

function searchFrom(value: unknown): false | SearchConfig {
  if (value === false) return false;
  if (!isPlainObject(value)) return {};
  return typeof value.text === "number" ? { text: value.text } : {};
}

function diagnosticFromAjv(
  error: ErrorObject,
  file: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): Diagnostic {
  if (error.keyword === "additionalProperties") {
    const key = String(error.params["additionalProperty"] ?? "");
    const path = [...instancePath(error.instancePath), key];
    const pair = getMapPair(doc, path);
    const pos = pair?.key ? posFromNode(file, lineCounter, pair.key as Node) : posFromNode(file, lineCounter, doc.contents);
    return {
      id: "config.unknown-key",
      severity: "error",
      message: `Unknown key \`${key}\`.`,
      pos,
      help: "Remove it or rename it to a key in the site config schema.",
    };
  }

  const path = instancePath(error.instancePath);
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
  const where = path.length === 0 ? "site config" : `\`${path.map(String).join(".")}\``;
  return {
    id: "config.invalid",
    severity: "error",
    message: `${where} ${error.message ?? "is invalid"}.`,
    pos: posFromNode(file, lineCounter, isNode(node) ? node : doc.contents),
  };
}

function instancePath(path: string): Array<string | number> {
  if (!path || path === "") return [];
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : decodeURIComponent(s)));
}

function getMapPair(doc: Document.Parsed, path: Array<string | number>): Pair | undefined {
  if (path.length === 0) return undefined;
  let node: Node | null | undefined = doc.contents ?? undefined;
  for (let i = 0; i < path.length - 1; i++) {
    if (node == null) return undefined;
    if (isMap(node) || isSeq(node)) {
      node = node.get(path[i]!, true) as Node | null | undefined;
    } else {
      return undefined;
    }
  }
  if (!isMap(node)) return undefined;
  const last = path[path.length - 1]!;
  return node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(last));
}

function posFromNode(file: string, lineCounter: LineCounter, node: Node | null | undefined): SourcePos {
  const range = node?.range;
  if (!range) return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  const start = lineCounter.linePos(range[0]);
  const endOffset = Math.max(range[0], (range[2] ?? range[1]) - 1);
  const end = lineCounter.linePos(endOffset);
  return { file, line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
}

function isNode(value: unknown): value is Node {
  return value != null && typeof value === "object" && "range" in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posixRelative(from: string, to: string): string {
  const rel = relative(from, to).replace(/\\/g, "/");
  return rel === "" ? CONFIG_FILE : rel;
}
