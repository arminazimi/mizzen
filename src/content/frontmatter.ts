import { parseDocument } from "yaml";
import type { Diagnostic } from "../contracts/index.ts";

/** The result of splitting a source file into front matter and body. */
export interface FrontMatterResult {
  /** The parsed front matter; `{}` when there is none or it is invalid. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Everything after the front matter, with its original line endings. */
  readonly body: string;
  /** 1-based line of the file where `body` starts, so body positions map back to the source. */
  readonly bodyLine: number;
  /** Problems found in the front matter; empty when it is valid or absent. */
  readonly diagnostics: readonly Diagnostic[];
}

const FENCE = /^---[ \t]*$/;

/** Split `---` YAML front matter from the body. `file` is only used for diagnostic positions. */
export function parseFrontMatter(source: string, file: string): FrontMatterResult {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const lines = text.split(/(?<=\n)/); // keep each line's terminator
  const strip = (line: string): string => line.replace(/\r?\n$/, "");

  if (lines.length === 0 || !FENCE.test(strip(lines[0]!))) {
    return { data: {}, body: text, bodyLine: 1, diagnostics: [] };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(strip(lines[i]!))) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return {
      data: {},
      body: text,
      bodyLine: 1,
      diagnostics: [{
        id: "frontmatter.unclosed",
        severity: "error",
        message: "Front matter starts with `---` but is never closed.",
        pos: { file, line: 1, column: 1, endLine: lines.length, endColumn: 1 },
        help: "Add a closing `---` line after the front matter.",
      }],
    };
  }

  const yamlText = lines.slice(1, close).join("");
  const body = lines.slice(close + 1).join("");
  const bodyLine = close + 2;
  const diagnostics: Diagnostic[] = [];
  let data: Record<string, unknown> = {};

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      const end = error.linePos?.[1] ?? start;
      diagnostics.push({
        id: "frontmatter.invalid-yaml",
        severity: "error",
        message: `Invalid YAML in front matter: ${error.message.split("\n")[0]}`,
        pos: {
          file,
          line: 1 + (start?.line ?? 1),
          column: start?.col ?? 1,
          endLine: 1 + (end?.line ?? start?.line ?? 1),
          endColumn: end?.col ?? start?.col ?? 1,
        },
      });
    }
  } else {
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) {
      data = {};
    } else if (typeof value === "object" && !Array.isArray(value)) {
      data = value as Record<string, unknown>;
    } else {
      diagnostics.push({
        id: "frontmatter.not-a-mapping",
        severity: "error",
        message: "Front matter must be a YAML mapping of keys to values.",
        pos: { file, line: 2, column: 1, endLine: Math.max(2, close), endColumn: 1 },
      });
    }
  }

  return { data, body, bodyLine, diagnostics };
}
