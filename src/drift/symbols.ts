/**
 * Extracts the symbols a TypeScript file exports, with their kind and line.
 *
 * This is a small scanner, not a parser: it skips strings, template literals, comments, and regular expressions,
 * tracks brace depth so a declaration inside a block is never mistaken for an export, and reads the header of each
 * top-level `export`. It needs no TypeScript compiler and never throws at its caller: a source it cannot read
 * yields an empty list and a `drift.symbols-syntax` diagnostic.
 */
import { readFile } from "node:fs/promises";
import type { Diagnostic, SourcePos } from "../contracts/index.ts";

/** What an exported name declares. */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var"
  | "namespace";

/** One exported name and where it is declared. */
export interface ExportedSymbol {
  /** The name the module exports, which is the alias in `export { a as b }`. */
  readonly name: string;
  /** What it declares. A re-export whose origin is unknown is reported as `const`. */
  readonly kind: SymbolKind;
  /** 1-based line of the name (or of the `export` keyword for an anonymous default). */
  readonly line: number;
}

/** What {@link exportedSymbols} found. */
export interface ExportedSymbolsResult {
  /** Exported names sorted by line, then by name (code-point order). */
  readonly symbols: readonly ExportedSymbol[];
  /** Findings; a syntax error leaves `symbols` empty. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link exportedSymbols}. */
export interface ExportedSymbolsOptions {
  /** Path used in diagnostics; defaults to `source.ts` for source text, or the file path itself. */
  readonly file?: string;
}

/** Source text to scan, optionally labelled for diagnostics. */
export interface ExportedSymbolsSource {
  /** The TypeScript text. */
  readonly source: string;
  /** Path used in diagnostics. */
  readonly file?: string;
}

/** A file to read and scan. */
export interface ExportedSymbolsFile {
  /** Path of the TypeScript file, absolute or relative to the working directory. */
  readonly file: string;
}

/** A syntax problem found by the scanner, with the index where it was noticed. */
class SourceSyntaxError extends Error {
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.name = "SourceSyntaxError";
    this.index = index;
  }
}

/** The declaration names seen at the top level, so a re-export can keep the kind of the name it aliases. */
type Declarations = Map<string, SymbolKind>;

/**
 * Returns the names `source` exports. Source text is scanned synchronously; `{ file }` reads the file and returns a
 * promise. Never throws: an unreadable or malformed source returns no symbols and a diagnostic.
 */
export function exportedSymbols(source: string, options?: ExportedSymbolsOptions): ExportedSymbolsResult;
export function exportedSymbols(input: ExportedSymbolsSource, options?: ExportedSymbolsOptions): ExportedSymbolsResult;
export function exportedSymbols(input: ExportedSymbolsFile, options?: ExportedSymbolsOptions): Promise<ExportedSymbolsResult>;
export function exportedSymbols(
  input: string | ExportedSymbolsSource | ExportedSymbolsFile,
  options: ExportedSymbolsOptions = {},
): ExportedSymbolsResult | Promise<ExportedSymbolsResult> {
  if (typeof input === "string") return scanSource(input, options.file);
  if ("source" in input) return scanSource(input.source, input.file ?? options.file);

  const file = input.file;
  return readFile(file, "utf8").then(
    (text) => scanSource(text, options.file ?? file),
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        symbols: [],
        diagnostics: [
          {
            id: "drift.symbols-read",
            severity: "error",
            message: `Cannot read "${file}": ${detail}.`,
            pos: atFile(file),
            help: "Point the reader at a TypeScript file that exists.",
          },
        ],
      } satisfies ExportedSymbolsResult;
    },
  );
}

/** Scans source text and turns a syntax problem into an empty result plus a diagnostic. */
function scanSource(source: string, file: string | undefined): ExportedSymbolsResult {
  const path = file ?? "source.ts";
  const starts = lineStarts(source);
  try {
    return { symbols: sortSymbols(scan(source, starts)), diagnostics: [] };
  } catch (err) {
    const index = err instanceof SourceSyntaxError ? err.index : 0;
    const detail = err instanceof Error ? err.message : String(err);
    const pos = positionAt(source, starts, path, index);
    return {
      symbols: [],
      diagnostics: [
        {
          id: "drift.symbols-syntax",
          severity: "error",
          message: `Cannot parse the exports of "${path}": ${detail}.`,
          pos,
          help: "Fix the TypeScript syntax near this position.",
        },
      ],
    };
  }
}

/** The scanning loop: skip everything that cannot hold code, then read each top-level `export`. */
function scan(source: string, starts: readonly number[]): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  const declarations: Declarations = new Map();
  let depth = 0;
  let index = 0;

  while (index < source.length) {
    const ch = source[index] as string;
    const next = source[index + 1];

    if (ch === "/" && next === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = endOfString(source, index, ch);
      continue;
    }
    if (ch === "`") {
      index = endOfTemplate(source, index);
      continue;
    }
    if (ch === "/" && isRegexStart(source, index)) {
      index = endOfRegex(source, index);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) throw new SourceSyntaxError("Unexpected closing brace", index);
      depth -= 1;
      index += 1;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const start = index;
      index = endOfIdentifier(source, index);
      const word = source.slice(start, index);
      if (word === "export" && depth === 0 && isStatementStart(source, start)) {
        parseExport(source, start, index, starts, declarations, symbols);
      }
      continue;
    }
    index += 1;
  }

  if (depth !== 0) throw new SourceSyntaxError("Unclosed block", source.length);
  return symbols;
}

/** Reads the declaration that starts after an `export` keyword. */
function parseExport(
  source: string,
  exportStart: number,
  afterExport: number,
  starts: readonly number[],
  declarations: Declarations,
  symbols: ExportedSymbol[],
): void {
  let index = skipTrivia(source, afterExport);
  let isDefault = false;

  // Modifiers can come in this order: default, declare/abstract, async.
  for (;;) {
    const token = readIdentifier(source, index);
    if (token === null) break;
    if (token.name === "default" && !isDefault) {
      isDefault = true;
      index = skipTrivia(source, token.end);
      continue;
    }
    if (token.name === "declare" || token.name === "abstract") {
      index = skipTrivia(source, token.end);
      continue;
    }
    if (token.name === "async") {
      index = skipTrivia(source, token.end);
      continue;
    }
    break;
  }

  const first = source[index] as string | undefined;
  if (first === "{") {
    parseExportBlock(source, index, starts, false, declarations, symbols);
    return;
  }
  if (first === "*") {
    parseExportStar(source, index, starts, symbols);
    return;
  }
  if (first === "=") {
    parseExportAssignment(source, index, starts, declarations, symbols);
    return;
  }

  const token = readIdentifier(source, index);
  if (token === null) {
    if (isDefault) return;
    throw new SourceSyntaxError("Expected a declaration after export", exportStart);
  }

  switch (token.name) {
    case "function": {
      const name = readDeclarationName(source, token.end, true);
      if (name === null) {
        if (isDefault) {
          addSymbol(symbols, declarations, "default", "function", lineAt(starts, token.start));
          return;
        }
        throw new SourceSyntaxError("Expected a function name", token.end);
      }
      addSymbol(symbols, declarations, name.name, "function", lineAt(starts, name.start));
      return;
    }
    case "class": {
      const name = readDeclarationName(source, token.end, false);
      if (name === null) {
        if (isDefault) {
          addSymbol(symbols, declarations, "default", "class", lineAt(starts, token.start));
          return;
        }
        throw new SourceSyntaxError("Expected a class name", token.end);
      }
      addSymbol(symbols, declarations, name.name, "class", lineAt(starts, name.start));
      return;
    }
    case "interface": {
      const name = requireName(source, token.end, "interface");
      addSymbol(symbols, declarations, name.name, "interface", lineAt(starts, name.start));
      return;
    }
    case "enum": {
      const name = requireName(source, token.end, "enum");
      addSymbol(symbols, declarations, name.name, "enum", lineAt(starts, name.start));
      return;
    }
    case "type": {
      parseTypeExport(source, token.end, starts, declarations, symbols);
      return;
    }
    case "namespace":
    case "module": {
      const name = requireName(source, token.end, token.name);
      addSymbol(symbols, declarations, name.name, "namespace", lineAt(starts, name.start));
      return;
    }
    case "const":
    case "let":
    case "var": {
      parseVariableExport(source, token, token.name, starts, declarations, symbols);
      return;
    }
    case "import": {
      // `export import Name = require("module")` exports a namespace-like alias.
      const name = requireName(source, token.end, "import");
      addSymbol(symbols, declarations, name.name, "namespace", lineAt(starts, name.start));
      return;
    }
    default: {
      if (!isDefault) throw new SourceSyntaxError(`Unknown export declaration "${token.name}"`, token.start);
      addSymbol(
        symbols,
        declarations,
        token.name,
        declarations.get(token.name) ?? "const",
        lineAt(starts, token.start),
      );
      return;
    }
  }
}

/** Reads `export type Name = ...` or `export type { Name }`. */
function parseTypeExport(
  source: string,
  afterType: number,
  starts: readonly number[],
  declarations: Declarations,
  symbols: ExportedSymbol[],
): void {
  const index = skipTrivia(source, afterType);
  const ch = source[index];
  if (ch === "{") {
    parseExportBlock(source, index, starts, true, declarations, symbols);
    return;
  }
  if (ch === "*") return;
  const name = requireName(source, index, "type");
  addSymbol(symbols, declarations, name.name, "type", lineAt(starts, name.start));
}

/** Reads `export const`, `let`, or `var`, including `export const enum`. */
function parseVariableExport(
  source: string,
  keyword: Identifier,
  kind: "const" | "let" | "var",
  starts: readonly number[],
  declarations: Declarations,
  symbols: ExportedSymbol[],
): void {
  const index = skipTrivia(source, keyword.end);
  const token = readIdentifier(source, index);
  if (token !== null && token.name === "enum") {
    const name = requireName(source, token.end, "enum");
    addSymbol(symbols, declarations, name.name, "enum", lineAt(starts, name.start));
    return;
  }
  if (token === null) {
    throw new SourceSyntaxError(`Expected a ${kind} name`, keyword.end);
  }
  addSymbol(symbols, declarations, token.name, kind, lineAt(starts, token.start));
}

/** Reads `export { a, b as c }` and `export type { X }`. */
function parseExportBlock(
  source: string,
  open: number,
  starts: readonly number[],
  isTypeBlock: boolean,
  declarations: Declarations,
  symbols: ExportedSymbol[],
): void {
  let index = open + 1;
  for (;;) {
    index = skipTrivia(source, index);
    if (index >= source.length) throw new SourceSyntaxError("Unterminated export list", open);
    if (source[index] === "}") return;

    let specifierIsType = isTypeBlock;
    const maybeType = readIdentifier(source, index);
    if (!isTypeBlock && maybeType !== null && maybeType.name === "type") {
      const after = skipTrivia(source, maybeType.end);
      const next = readIdentifier(source, after);
      // `export { type }` and `export { type as t }` name a value called `type`;
      // `export { type Foo }` marks the specifier as a type.
      if (next !== null && next.name !== "as" && next.name !== "from") {
        specifierIsType = true;
        index = after;
      }
    }

    const local = readModuleName(source, index);
    if (local === null) throw new SourceSyntaxError("Expected a name in the export list", index);
    index = skipTrivia(source, local.end);

    const as = readIdentifier(source, index);
    let exported = local;
    if (as !== null && as.name === "as") {
      const alias = readModuleName(source, skipTrivia(source, as.end));
      if (alias === null) throw new SourceSyntaxError("Expected a name after `as`", as.end);
      exported = alias;
      index = skipTrivia(source, alias.end);
    }

    const kind = specifierIsType ? "type" : (declarations.get(local.name) ?? "const");
    addSymbol(symbols, declarations, exported.name, kind, lineAt(starts, exported.start));

    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] === "}") return;
    throw new SourceSyntaxError("Expected `,` or `}` in the export list", index);
  }
}

/** Reads `export * as name from "..."`; a bare `export *` exports no name. */
function parseExportStar(
  source: string,
  star: number,
  starts: readonly number[],
  symbols: ExportedSymbol[],
): void {
  const index = skipTrivia(source, star + 1);
  const as = readIdentifier(source, index);
  if (as === null || as.name !== "as") return;
  const name = readModuleName(source, skipTrivia(source, as.end));
  if (name === null) throw new SourceSyntaxError("Expected a namespace name after `as`", as.end);
  symbols.push({ name: name.name, kind: "namespace", line: lineAt(starts, name.start) });
}

/** Reads `export = name`, the TypeScript CommonJS export assignment. */
function parseExportAssignment(
  source: string,
  equals: number,
  starts: readonly number[],
  declarations: Declarations,
  symbols: ExportedSymbol[],
): void {
  const name = requireName(source, equals + 1, "export assignment");
  addSymbol(
    symbols,
    declarations,
    name.name,
    declarations.get(name.name) ?? "const",
    lineAt(starts, name.start),
  );
}

/** Reads the optional `*` and the required name after `function`; a default export may omit it. */
function readDeclarationName(source: string, afterKeyword: number, allowStar: boolean): Identifier | null {
  let index = skipTrivia(source, afterKeyword);
  if (allowStar && source[index] === "*") index = skipTrivia(source, index + 1);
  return readIdentifier(source, index);
}

/** Reads a declaration name or rejects the source. */
function requireName(source: string, index: number, what: string): Identifier {
  const name = readIdentifier(source, skipTrivia(source, index));
  if (name === null) throw new SourceSyntaxError(`Expected a name after \`${what}\``, index);
  return name;
}

/** Adds one symbol and remembers its kind for a later re-export. */
function addSymbol(
  symbols: ExportedSymbol[],
  declarations: Declarations,
  name: string,
  kind: SymbolKind,
  line: number,
): void {
  symbols.push({ name, kind, line });
  if (!declarations.has(name)) declarations.set(name, kind);
}

/** Sorts by line, then name, and drops a repeated export name. */
function sortSymbols(symbols: readonly ExportedSymbol[]): ExportedSymbol[] {
  const sorted = [...symbols].sort((a, b) => a.line - b.line || compareCodePoints(a.name, b.name));
  const seen = new Set<string>();
  return sorted.filter((symbol) => {
    if (seen.has(symbol.name)) return false;
    seen.add(symbol.name);
    return true;
  });
}

/** Compares by code point, never by locale. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One identifier-like token. */
interface Identifier {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** Reads an identifier at `index`, or null when there is none. */
function readIdentifier(source: string, index: number): Identifier | null {
  const ch = source[index];
  if (ch === undefined || !isIdentifierStart(ch)) return null;
  const end = endOfIdentifier(source, index);
  return { name: source.slice(index, end), start: index, end };
}

/** Reads an identifier or a quoted module name in an export list. */
function readModuleName(source: string, index: number): Identifier | null {
  const ch = source[index];
  if (ch === '"' || ch === "'") {
    const end = endOfString(source, index, ch);
    return { name: source.slice(index + 1, end - 1), start: index, end };
  }
  return readIdentifier(source, index);
}

/** True for the start of an identifier. Non-ASCII is accepted and read as an identifier for scanning purposes. */
function isIdentifierStart(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return ch === "_" || ch === "$" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
}

/** True for the continuation of an identifier. */
function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}

/** Number of code units in an identifier starting at `index`. */
function endOfIdentifier(source: string, index: number): number {
  let end = index + 1;
  while (end < source.length && isIdentifierPart(source[end] as string)) end += 1;
  return end;
}

/** True when an `export` word sits where a statement may start, so `obj.export` is not read as a declaration. */
function isStatementStart(source: string, index: number): boolean {
  // A declaration normally starts its line; this also covers a line after a `//` comment.
  let lineStart = index;
  while (lineStart > 0 && source[lineStart - 1] !== "\n" && source[lineStart - 1] !== "\r") lineStart -= 1;
  let onlyTriviaOnLine = true;
  for (let at = lineStart; at < index; at += 1) {
    if (!isWhitespace(source[at] as string)) {
      onlyTriviaOnLine = false;
      break;
    }
  }
  if (onlyTriviaOnLine) return true;

  let previous = index - 1;
  while (previous >= 0 && isWhitespace(source[previous] as string)) previous -= 1;
  if (previous < 0) return true;
  const ch = source[previous] as string;
  if (ch === "." || ch === "?" || isIdentifierPart(ch)) return false;
  if (ch === ";" || ch === "}" || ch === "{" || ch === ")" || ch === "]") return true;
  return hasNewline(source, previous + 1, index);
}

/** True when the `/` at `index` starts a regular expression rather than a division. */
function isRegexStart(source: string, index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && isWhitespace(source[previous] as string)) previous -= 1;
  if (previous < 0) return true;
  const ch = source[previous] as string;
  if ("=(:,[!&|?{};+-*%<>~^".includes(ch)) return true;
  if (isIdentifierPart(ch)) {
    const word = previousWord(source, previous + 1);
    return (
      word === "return" ||
      word === "typeof" ||
      word === "case" ||
      word === "delete" ||
      word === "void" ||
      word === "throw" ||
      word === "new" ||
      word === "in" ||
      word === "of" ||
      word === "yield" ||
      word === "await"
    );
  }
  return false;
}

/** The identifier ending at `end` (exclusive), for regex-position checks. */
function previousWord(source: string, end: number): string {
  let start = end;
  while (start > 0 && isIdentifierPart(source[start - 1] as string)) start -= 1;
  return source.slice(start, end);
}

/** Skips whitespace and comments. */
function skipTrivia(source: string, index: number): number {
  let current = index;
  while (current < source.length) {
    const ch = source[current] as string;
    if (isWhitespace(ch)) {
      current += 1;
      continue;
    }
    if (ch === "/" && source[current + 1] === "/") {
      current = endOfLineComment(source, current);
      continue;
    }
    if (ch === "/" && source[current + 1] === "*") {
      const end = source.indexOf("*/", current + 2);
      if (end === -1) throw new SourceSyntaxError("Unterminated comment", current);
      current = end + 2;
      continue;
    }
    break;
  }
  return current;
}

/** Index just after a `//` comment. */
function endOfLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2);
  return newline === -1 ? source.length : newline + 1;
}

/** Index just after a quoted string. */
function endOfString(source: string, index: number, quote: string): number {
  let current = index + 1;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === quote) return current + 1;
    if (ch === "\n" || ch === "\r") throw new SourceSyntaxError("Unterminated string", index);
    current += 1;
  }
  throw new SourceSyntaxError("Unterminated string", index);
}

/** Index just after a template literal. Its `${...}` expressions are ignored with it. */
function endOfTemplate(source: string, index: number): number {
  let current = index + 1;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === "`") return current + 1;
    current += 1;
  }
  throw new SourceSyntaxError("Unterminated template literal", index);
}

/** Index just after a regular expression literal, including its flags. */
function endOfRegex(source: string, index: number): number {
  let current = index + 1;
  let inClass = false;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      current += 1;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      current += 1;
      continue;
    }
    if (ch === "/" && !inClass) {
      current += 1;
      while (current < source.length && isIdentifierPart(source[current] as string)) current += 1;
      return current;
    }
    if (ch === "\n" || ch === "\r") throw new SourceSyntaxError("Unterminated regular expression", index);
    current += 1;
  }
  throw new SourceSyntaxError("Unterminated regular expression", index);
}

/** True for whitespace characters the scanner ignores between tokens. */
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\uFEFF";
}

/** True when `text` holds a line break. */
function hasNewline(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\n" || text[index] === "\r") return true;
  }
  return false;
}

/** The 0-based index of the start of every line. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** 1-based line of `index`. */
function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** A one-character position at `index`, in code points. */
function positionAt(source: string, starts: readonly number[], file: string, index: number): SourcePos {
  const clamped = Math.max(0, Math.min(index, source.length));
  const line = lineAt(starts, clamped);
  const lineStart = starts[line - 1] as number;
  const column = [...source.slice(lineStart, clamped)].length + 1;
  return { file, line, column, endLine: line, endColumn: column };
}

/** A position at the start of a file, for a diagnostic that is not about one character. */
function atFile(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}
