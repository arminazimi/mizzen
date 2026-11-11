/**
 * Extracts the symbols a TypeScript file exports, with their kind, line, and normalized API signature.
 *
 * This is a small scanner, not a parser: it skips strings, template literals, comments, and regular expressions,
 * tracks brace depth so a declaration inside a block is never mistaken for an export, and reads the header of each
 * top-level `export`. It needs no TypeScript compiler and never throws at its caller: a source it cannot read
 * yields an empty list and a `drift.symbols-syntax` diagnostic.
 *
 * A signature keeps what a caller depends on and drops what they do not: whitespace, comments, quote style
 * where the strings mean the same, trailing punctuation, function bodies, and property initializers. It
 * covers function parameters, optionality, defaults as optionality, generics, return types, class and
 * interface members, type alias right-hand sides, annotated variables, and function-valued consts.
 * Overloads keep one signature per declaration. A class or interface signature compares only the members
 * the documentation states, so a partial example stays valid while a changed member does not.
 *
 * Not every declaration has a comparable API. A value whose type is inferred, an enum, a namespace, a
 * re-export from another module, and a member whose shape the scanner cannot read carry an `unchecked`
 * reason instead of a guessed signature. The drift comparison reports that reason as an explicitly
 * unchecked finding rather than treating the citation as clean.
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

/** One normalized parameter of a function-like declaration. */
export interface SignatureParam {
  /** Canonical text of the whole parameter, without its surrounding commas. */
  readonly text: string;
  /** The parameter's name, when it is a plain identifier. */
  readonly name?: string;
  /** Canonical type text, when the parameter is annotated. */
  readonly type?: string;
  /** True when the parameter is optional (`?`) or has a default. */
  readonly optional: boolean;
  /** True for a rest parameter (`...items`). */
  readonly rest: boolean;
}

/**
 * One normalized API signature of an exported declaration. Whitespace, comments, quote style where
 * equivalent, and declaration formatting are removed, so two declarations that mean the same thing have
 * the same text. Function bodies and property initializers are not part of a signature.
 */
export interface SymbolSignature {
  /** Canonical signature text, for people and for exact comparison. */
  readonly text: string;
  /** 1-based line where the declaration it came from starts. */
  readonly line: number;
  /** Canonical parameters, in order; a function-like signature always has this. */
  readonly params?: readonly SignatureParam[];
  /** Canonical generic parameter list including the angle brackets, when written. */
  readonly generics?: string;
  /** Canonical return type without its colon, when written. */
  readonly returns?: string;
  /** Canonical `extends`/`implements` clause for a class or interface, when written. */
  readonly heritage?: string;
  /** Canonical right-hand side of a type alias, or the annotated type of a const. */
  readonly alias?: string;
  /** Canonical member signatures of a class or interface body. */
  readonly members?: readonly string[];
}

/** A documented claim read from inline code: a bare name, a call, or a signature. */
export interface DocumentedClaim {
  /** The identifier the inline code names. */
  readonly name: string;
  /** `name` compares the name only; `call` compares arity; `signature` compares the stated API. */
  readonly form: "name" | "call" | "signature";
  /** The declaration keyword the documentation spelled, when it spelled one. */
  readonly kind?: "function" | "class" | "interface" | "type" | "const";
  /** The documented signature, for `call` and `signature`. */
  readonly signature?: SymbolSignature;
  /** Why the documented form cannot be compared, when it cannot. */
  readonly unchecked?: string;
}

/** The result of comparing one documented signature with one exported declaration. */
export type SignatureCheck =
  | { readonly state: "match" }
  | { readonly state: "mismatch" }
  | { readonly state: "unchecked"; readonly reason: string };

/** One exported name and where it is declared. */
export interface ExportedSymbol {
  /** The name the module exports, which is the alias in `export { a as b }`. */
  readonly name: string;
  /** What it declares. A re-export whose origin is unknown is reported as `const`. */
  readonly kind: SymbolKind;
  /** 1-based line of the name (or of the `export` keyword for an anonymous default). */
  readonly line: number;
  /** Every normalized signature of this name, in source order; absent when nothing is comparable. */
  readonly signatures?: readonly SymbolSignature[];
  /** Why the API cannot all be compared, when part of it cannot; a matched signature still wins. */
  readonly unchecked?: string;
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

/** The declaration names seen at the top level, so a re-export can keep the kind and API of the name it aliases. */
type Declarations = Map<string, Declaration>;

/** What a scanned declaration exports: its kind plus whatever API the scanner could read. */
interface Declaration {
  readonly kind: SymbolKind;
  readonly signatures?: readonly SymbolSignature[];
  readonly unchecked?: string;
}

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
  let isAsync = false;

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
      isAsync = true;
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
          const afterKeyword = skipTrivia(source, token.end);
          const generator = source[afterKeyword] === "*";
          const afterStar = generator ? skipTrivia(source, afterKeyword + 1) : afterKeyword;
          const signature = functionSignature(source, starts, "default", token.start, afterStar, isAsync, generator);
          addSymbol(symbols, declarations, "default", "function", lineAt(starts, token.start), {
            signatures: [signature],
          });
          return;
        }
        throw new SourceSyntaxError("Expected a function name", token.end);
      }
      const generator = source.slice(token.end, name.start).includes("*");
      const signature = functionSignature(source, starts, name.name, name.start, name.end, isAsync, generator);
      addSymbol(symbols, declarations, name.name, "function", lineAt(starts, name.start), {
        signatures: [signature],
      });
      return;
    }
    case "class": {
      const name = readDeclarationName(source, token.end, false);
      if (name === null) {
        if (isDefault) {
          addSymbol(symbols, declarations, "default", "class", lineAt(starts, token.start), classApi(source, starts, {
            name: "default",
            start: token.start,
            end: token.end,
          }));
          return;
        }
        throw new SourceSyntaxError("Expected a class name", token.end);
      }
      addSymbol(symbols, declarations, name.name, "class", lineAt(starts, name.start), classApi(source, starts, name));
      return;
    }
    case "interface": {
      const name = requireName(source, token.end, "interface");
      addSymbol(symbols, declarations, name.name, "interface", lineAt(starts, name.start), interfaceApi(source, starts, name));
      return;
    }
    case "enum": {
      const name = requireName(source, token.end, "enum");
      addSymbol(symbols, declarations, name.name, "enum", lineAt(starts, name.start), {
        unchecked: "an enum has no comparable signature",
      });
      return;
    }
    case "type": {
      parseTypeExport(source, token.end, starts, declarations, symbols);
      return;
    }
    case "namespace":
    case "module": {
      const name = requireName(source, token.end, token.name);
      addSymbol(symbols, declarations, name.name, "namespace", lineAt(starts, name.start), {
        unchecked: "a namespace has no comparable signature",
      });
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
      addSymbol(symbols, declarations, name.name, "namespace", lineAt(starts, name.start), {
        unchecked: "a namespace alias has no comparable signature",
      });
      return;
    }
    default: {
      if (!isDefault) throw new SourceSyntaxError(`Unknown export declaration "${token.name}"`, token.start);
      const known = declarations.get(token.name);
      addSymbol(
        symbols,
        declarations,
        token.name,
        known?.kind ?? "const",
        lineAt(starts, token.start),
        known ?? { unchecked: "the declaration behind this default export is not known" },
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
  addSymbol(symbols, declarations, name.name, "type", lineAt(starts, name.start), typeApi(source, starts, name));
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
    addSymbol(symbols, declarations, name.name, "enum", lineAt(starts, name.start), {
      unchecked: "an enum has no comparable signature",
    });
    return;
  }
  if (token === null) {
    throw new SourceSyntaxError(`Expected a ${kind} name`, keyword.end);
  }
  addSymbol(symbols, declarations, token.name, kind, lineAt(starts, token.start), variableApi(source, starts, token));
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

    const kind = specifierIsType ? "type" : (declarations.get(local.name)?.kind ?? "const");
    const declaration = exportBlockHasFrom(source, open) ? undefined : declarations.get(local.name);
    const line = lineAt(starts, exported.start);
    const api = declaration === undefined
      ? { unchecked: "a re-exported name has no local declaration to compare" }
      : {
        ...declaration,
        ...(declaration.signatures === undefined
          ? {}
          : { signatures: declaration.signatures.map((signature) => ({ ...signature, line })) }),
      };
    addSymbol(symbols, declarations, exported.name, kind, line, api);

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
  symbols.push({
    name: name.name,
    kind: "namespace",
    line: lineAt(starts, name.start),
    unchecked: "a namespace re-export has no local declaration to compare",
  });
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
  const known = declarations.get(name.name);
  addSymbol(
    symbols,
    declarations,
    name.name,
    known?.kind ?? "const",
    lineAt(starts, name.start),
    known ?? { unchecked: "the declaration behind this export assignment is not known" },
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

/** Adds one symbol, its API, and remembers both for a later re-export. */
function addSymbol(
  symbols: ExportedSymbol[],
  declarations: Declarations,
  name: string,
  kind: SymbolKind,
  line: number,
  api: { readonly signatures?: readonly SymbolSignature[]; readonly unchecked?: string } = {},
): void {
  symbols.push({
    name,
    kind,
    line,
    ...(api.signatures === undefined ? {} : { signatures: api.signatures }),
    ...(api.unchecked === undefined ? {} : { unchecked: api.unchecked }),
  });
  if (!declarations.has(name)) declarations.set(name, { kind, ...api });
  else {
    const kept = declarations.get(name) as Declaration;
    const signatures = [...(kept.signatures ?? []), ...(api.signatures ?? [])];
    const unchecked = kept.unchecked ?? api.unchecked;
    declarations.set(name, {
      kind: kept.kind,
      ...(signatures.length === 0 ? {} : { signatures }),
      ...(unchecked === undefined ? {} : { unchecked }),
    });
  }
}

/** True when an `export { ... }` list is followed by `from`, so its names come from another module. */
function exportBlockHasFrom(source: string, open: number): boolean {
  let index = skipTrivia(source, open + 1);
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "}") {
      const from = readIdentifier(source, skipTrivia(source, index + 1));
      return from !== null && from.name === "from";
    }
    if (ch === '"' || ch === "'") {
      index = endOfString(source, index, ch);
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = end + 2;
      continue;
    }
    index += 1;
  }
  return false;
}

/** What a class, interface, type alias, or variable exposes as its API. */
interface DeclaredApi {
  readonly signatures?: readonly SymbolSignature[];
  readonly unchecked?: string;
}

/** A function's signature after its name: its generics, parameters, and return type. */
interface FunctionTail {
  readonly params: readonly SignatureParam[];
  readonly generics?: string;
  readonly returns?: string;
}

/** Reads `function`'s signature from just after its optional name. */
function functionSignature(
  source: string,
  starts: readonly number[],
  displayName: string,
  keywordStart: number,
  afterName: number,
  isAsync: boolean,
  generator: boolean,
): SymbolSignature {
  const tail = functionTail(source, afterName);
  const line = lineAt(starts, keywordStart);
  return {
    text: `${isAsync ? "async " : ""}function${generator ? "*" : ""} ${displayName}${tail.generics ?? ""}(${joinParams(tail.params)})${tail.returns === undefined ? "" : `: ${tail.returns}`}`,
    line,
    params: tail.params,
    ...(tail.generics === undefined ? {} : { generics: tail.generics }),
    ...(tail.returns === undefined ? {} : { returns: tail.returns }),
  };
}

/** Reads a function's generics, parameter list, and return type. */
function functionTail(source: string, afterName: number): FunctionTail {
  let index = skipTrivia(source, afterName);
  let generics: string | undefined;
  if (source[index] === "<") {
    const end = scanAngle(source, index);
    generics = canonical(source, index, end);
    index = skipTrivia(source, end);
  }
  if (source[index] !== "(") throw new SourceSyntaxError("Expected a parameter list", index);
  const { params, end } = readParams(source, index);
  const returns = readReturnType(source, end);
  return {
    params,
    ...(generics === undefined ? {} : { generics }),
    ...(returns === undefined ? {} : { returns }),
  };
}

/** Reads a parameter list starting at `(`, returning its parameters and the index after `)`. */
function readParams(
  source: string,
  open: number,
): { readonly params: readonly SignatureParam[]; readonly end: number } {
  const end = scanBalanced(source, open, "(", ")");
  return { params: parseParams(source, open + 1, end - 1), end };
}

/** The return type after a parameter list, when it is annotated. */
function readReturnType(source: string, afterParams: number): string | undefined {
  return returnTypeAt(source, afterParams).returns;
}

/** The return type and the index just after it, or the parameter end when there is none. */
function returnTypeAt(
  source: string,
  afterParams: number,
): { readonly returns?: string; readonly end: number } {
  const colon = skipTrivia(source, afterParams);
  if (source[colon] !== ":") return { end: afterParams };
  const end = returnTypeEnd(source, colon + 1);
  const text = canonical(source, colon + 1, end);
  return {
    end,
    ...(text === "" ? {} : { returns: text }),
  };
}

/** The canonical text of a parameter list, for display. */
function joinParams(params: readonly SignatureParam[]): string {
  return params.map((param) => param.text).join(", ");
}

/** Reads a class declaration's header and public member signatures. */
function classApi(source: string, starts: readonly number[], name: Identifier): DeclaredApi {
  const { generics, end } = readGenerics(source, name.end);
  const body = bodyOf(source, end);
  if (body === null) return { unchecked: "a class without a body has no comparable signature" };
  const heritage = canonicalOrUndefined(source, end, body.open);
  const parsed = parseMembers(source, body.open, body.close);
  const signature: SymbolSignature = {
    text: `class ${name.name}${generics ?? ""}${heritage === undefined ? "" : ` ${heritage}`}{${parsed.members.join(";")}}`,
    line: lineAt(starts, name.start),
    ...(generics === undefined ? {} : { generics }),
    ...(heritage === undefined ? {} : { heritage }),
    members: parsed.members,
  };
  return {
    signatures: [signature],
    ...(parsed.unchecked === undefined ? {} : { unchecked: parsed.unchecked }),
  };
}

/** Reads an interface declaration's header and member signatures. */
function interfaceApi(source: string, starts: readonly number[], name: Identifier): DeclaredApi {
  const { generics, end } = readGenerics(source, name.end);
  const body = bodyOf(source, end);
  if (body === null) return { unchecked: "an interface without a body has no comparable signature" };
  const heritage = canonicalOrUndefined(source, end, body.open);
  const parsed = parseMembers(source, body.open, body.close);
  const signature: SymbolSignature = {
    text: `interface ${name.name}${generics ?? ""}${heritage === undefined ? "" : ` ${heritage}`}{${parsed.members.join(";")}}`,
    line: lineAt(starts, name.start),
    ...(generics === undefined ? {} : { generics }),
    ...(heritage === undefined ? {} : { heritage }),
    members: parsed.members,
  };
  return {
    signatures: [signature],
    ...(parsed.unchecked === undefined ? {} : { unchecked: parsed.unchecked }),
  };
}

/** Reads a type alias's generic parameters and right-hand side. */
function typeApi(source: string, starts: readonly number[], name: Identifier): DeclaredApi {
  const { generics, end } = readGenerics(source, name.end);
  const equals = skipTrivia(source, end);
  if (source[equals] !== "=") return { unchecked: "a type alias without a right-hand side has no comparable signature" };
  const alias = canonical(source, equals + 1, typeAliasEnd(source, equals + 1));
  if (alias === "") return { unchecked: "a type alias without a right-hand side has no comparable signature" };
  return {
    signatures: [{
      text: `type ${name.name}${generics ?? ""} = ${alias}`,
      line: lineAt(starts, name.start),
      ...(generics === undefined ? {} : { generics }),
      alias,
    }],
  };
}

/** Reads a `const`/`let`/`var` declaration's annotated type or function-valued signature. */
function variableApi(source: string, starts: readonly number[], name: Identifier): DeclaredApi {
  let index = skipTrivia(source, name.end);
  if (source[index] === "?") index = skipTrivia(source, index + 1);
  if (source[index] === "!") index = skipTrivia(source, index + 1);

  if (source[index] === ":") {
    const annotation = canonical(source, index + 1, memberTypeEnd(source, index + 1, source.length));
    if (annotation === "") return { unchecked: "an unannotated declaration has no comparable signature" };
    return {
      signatures: [{
        text: `const ${name.name}: ${annotation}`,
        line: lineAt(starts, name.start),
        alias: annotation,
      }],
    };
  }

  if (source[index] !== "=") return { unchecked: "an unannotated declaration has no comparable signature" };
  const value = skipTrivia(source, index + 1);
  return functionValueApi(source, starts, name, value);
}

/** Reads a const initializer that is a function expression or an arrow function. */
function functionValueApi(source: string, starts: readonly number[], name: Identifier, value: number): DeclaredApi {
  let index = value;
  const asyncToken = readIdentifier(source, index);
  const isAsync = asyncToken !== null && asyncToken.name === "async";
  if (isAsync) index = skipTrivia(source, asyncToken.end);

  const keyword = readIdentifier(source, index);
  if (keyword !== null && keyword.name === "function") {
    let after = keyword.end;
    let generator = false;
    const star = skipTrivia(source, after);
    if (source[star] === "*") {
      generator = true;
      after = skipTrivia(source, star + 1);
    }
    const expressionName = readIdentifier(source, after);
    if (expressionName !== null) after = expressionName.end;
    const tail = functionTail(source, after);
    return {
      signatures: [{
        text: `const ${name.name} = ${isAsync ? "async " : ""}function${generator ? "*" : ""}${tail.generics ?? ""}(${joinParams(tail.params)})${tail.returns === undefined ? "" : `: ${tail.returns}`}`,
        line: lineAt(starts, name.start),
        params: tail.params,
        ...(tail.generics === undefined ? {} : { generics: tail.generics }),
        ...(tail.returns === undefined ? {} : { returns: tail.returns }),
      }],
    };
  }

  if (source[index] === "<" || source[index] === "(") {
    let generics: string | undefined;
    if (source[index] === "<") {
      const end = scanAngle(source, index);
      generics = canonical(source, index, end);
      index = skipTrivia(source, end);
    }
    if (source[index] !== "(") return { unchecked: "the initializer is not a function the scanner can read" };
    const { params, end } = readParams(source, index);
    const returns = readArrowReturn(source, end);
    const arrow = skipArrow(source, end);
    if (!arrow) return { unchecked: "the initializer is not a function the scanner can read" };
    return {
      signatures: [{
        text: `const ${name.name}${generics ?? ""}(${joinParams(params)})${returns === undefined ? "" : `: ${returns}`}`,
        line: lineAt(starts, name.start),
        params,
        ...(generics === undefined ? {} : { generics }),
        ...(returns === undefined ? {} : { returns }),
      }],
    };
  }

  const param = readIdentifier(source, index);
  if (param !== null) {
    const arrow = skipTrivia(source, param.end);
    if (source[arrow] === "=" && source[arrow + 1] === ">") {
      const returns = readArrowReturn(source, arrow + 2);
      return {
        signatures: [{
          text: `const ${name.name}(${param.name})${returns === undefined ? "" : `: ${returns}`}`,
          line: lineAt(starts, name.start),
          params: [{ text: param.name, name: param.name, optional: false, rest: false }],
          ...(returns === undefined ? {} : { returns }),
        }],
      };
    }
  }

  return { unchecked: "the scanner does not infer the type of a value initializer" };
}

/** The return type before an arrow's `=>`, when it is annotated. */
function readArrowReturn(source: string, afterParams: number): string | undefined {
  const colon = skipTrivia(source, afterParams);
  if (source[colon] !== ":") return undefined;
  const end = arrowReturnEnd(source, colon + 1);
  const text = canonical(source, colon + 1, end);
  return text === "" ? undefined : text;
}

/** True when `=>` follows the index, after trivia. */
function skipArrow(source: string, afterParams: number): boolean {
  let index = skipTrivia(source, afterParams);
  if (source[index] === ":") index = arrowReturnEnd(source, index + 1);
  index = skipTrivia(source, index);
  return source[index] === "=" && source[index + 1] === ">";
}

/**
 * The end of an arrow's annotated return type: the next top-level `=>`. A function type in the return
 * type should be parenthesized; an unparenthesized one stops at its own arrow.
 *
 * shortcut: that unparenthesized function type is read as the arrow, so document it in parentheses.
 */
function arrowReturnEnd(source: string, from: number): number {
  let index = from;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === "(") parens += 1;
    else if (ch === ")") {
      if (parens === 0) return index;
      parens -= 1;
    } else if (ch === "[") brackets += 1;
    else if (ch === "]") {
      if (brackets === 0) return index;
      brackets -= 1;
    } else if (ch === "{") braces += 1;
    else if (ch === "}") {
      if (braces === 0) return index;
      braces -= 1;
    } else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (ch === "=" && source[index + 1] === ">" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      return index;
    }
    index += 1;
  }
  return index;
}

/** Reads generic parameters, when written. */
function readGenerics(source: string, from: number): { readonly generics?: string; readonly end: number } {
  const index = skipTrivia(source, from);
  if (source[index] !== "<") return { end: index };
  const end = scanAngle(source, index);
  return { generics: canonical(source, index, end), end };
}

/** The canonical text between two indexes, or undefined when it holds only trivia. */
function canonicalOrUndefined(source: string, start: number, end: number): string | undefined {
  const text = canonical(source, start, end);
  return text === "" ? undefined : text;
}

/** The body braces of a declaration starting at `from`, skipping braces inside type arguments. */
function bodyOf(source: string, from: number): { readonly open: number; readonly close: number } | null {
  let index = from;
  let parens = 0;
  let brackets = 0;
  let angles = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (ch === "{") {
      if (parens === 0 && brackets === 0 && angles === 0) {
        return { open: index, close: scanBalanced(source, index, "{", "}") };
      }
      index = scanBalanced(source, index, "{", "}");
      continue;
    } else if (ch === ";" && parens === 0 && brackets === 0 && angles === 0) return null;
    index += 1;
  }
  return null;
}

/** One class or interface member, or why the body could not be read. */
interface MemberList {
  readonly members: readonly string[];
  readonly unchecked?: string;
}

/** Words that modify a member without being part of its API, or that are part of it. */
const DROPPED_MODIFIERS = new Set(["public", "declare", "override", "accessor"]);
const MEMBER_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "declare",
  "override",
  "accessor",
  "async",
  "get",
  "set",
]);

/** Reads the member signatures of a class or interface body. */
function parseMembers(source: string, open: number, close: number): MemberList {
  const members: string[] = [];
  let unchecked: string | undefined;
  let index = open + 1;
  const limit = close > open + 1 && source[close - 1] === "}" ? close - 1 : close;

  while (index < limit) {
    index = skipTrivia(source, index);
    if (index >= limit) break;
    const ch = source[index] as string;
    if (ch === "}") break;
    if (ch === ";" || ch === ",") {
      index += 1;
      continue;
    }
    if (ch === "#") {
      index = skipToMemberEnd(source, index, close);
      continue;
    }

    const prefix: string[] = [];
    let isPrivate = false;
    for (;;) {
      const token = readIdentifier(source, index);
      if (token === null || !MEMBER_MODIFIERS.has(token.name)) break;
      const after = skipTrivia(source, token.end);
      const next = source[after] as string | undefined;
      // A modifier word can itself be the member's name: `get()`, `static: number`.
      if (next === "(" || next === ":" || next === "=" || next === "?" || next === "!" || next === "<") break;
      if (token.name === "private" || token.name === "protected") isPrivate = true;
      else if (!DROPPED_MODIFIERS.has(token.name)) prefix.push(token.name);
      index = after;
    }
    if (isPrivate) {
      index = skipToMemberEnd(source, index, close);
      continue;
    }
    if (source[index] === "#") {
      index = skipToMemberEnd(source, index, close);
      continue;
    }

    const keyword = readIdentifier(source, index);
    if (keyword !== null && keyword.name === "constructor") {
      const after = skipTrivia(source, keyword.end);
      if (source[after] === "(") {
        const { params, end } = readParams(source, after);
        members.push(`${prefix.join(" ")}${prefix.length > 0 ? " " : ""}constructor(${joinParams(params)})`);
        index = afterMember(source, end, close);
        continue;
      }
    }

    if (source[index] === "[") {
      const bracket = scanBalanced(source, index, "[", "]");
      let at = skipTrivia(source, bracket);
      if (source[at] === "?") at = skipTrivia(source, at + 1);
      if (source[at] === ":") {
        const end = memberTypeEnd(source, at + 1, close);
        members.push(withPrefix(prefix, canonical(source, index, end)));
        index = skipTrivia(source, end);
        if (source[index] === ";") index += 1;
        continue;
      }
      unchecked ??= "an index signature without a type annotation";
      index = skipToMemberEnd(source, index, close);
      continue;
    }

    let nameEnd: number;
    if (keyword !== null) nameEnd = keyword.end;
    else if (ch === '"' || ch === "'") nameEnd = endOfString(source, index, ch);
    else if (ch >= "0" && ch <= "9") nameEnd = endOfNumber(source, index, close);
    else {
      unchecked ??= "an unrecognized class member";
      index = skipToMemberEnd(source, index, close);
      continue;
    }

    let at = skipTrivia(source, nameEnd);
    const optional = source[at] === "?";
    if (source[at] === "?" || source[at] === "!") at = skipTrivia(source, at + 1);

    let generics: string | undefined;
    let signatureStart = at;
    if (source[at] === "<") {
      const end = scanAngle(source, at);
      generics = canonical(source, at, end);
      signatureStart = skipTrivia(source, end);
    }

    if (source[signatureStart] === "(") {
      const { params, end } = readParams(source, signatureStart);
      const tail = returnTypeAt(source, end);
      members.push(
        withPrefix(
          prefix,
          `${canonical(source, index, nameEnd)}${generics ?? ""}${optional ? "?" : ""}(${joinParams(params)})${tail.returns === undefined ? "" : `: ${tail.returns}`}`,
        ),
      );
      index = afterMember(source, tail.end, close);
      continue;
    }

    if (source[at] === ":") {
      const end = memberTypeEnd(source, at + 1, close);
      members.push(withPrefix(prefix, canonical(source, index, end)));
      index = skipTrivia(source, end);
      if (source[index] === ";") index += 1;
      continue;
    }

    if (source[at] === "=") {
      // A property's initializer is not part of its API; its inferred type is not checked.
      members.push(withPrefix(prefix, canonical(source, index, at)));
      index = skipToMemberEnd(source, at + 1, close);
      unchecked ??= "a property with an inferred type has no comparable signature";
      continue;
    }

    members.push(withPrefix(prefix, canonical(source, index, nameEnd)));
    index = skipTrivia(source, nameEnd);
    if (source[index] === ";") index += 1;
  }

  return unchecked === undefined ? { members } : { members, unchecked };
}

/** Prefixes a member with the API modifiers that were read before it. */
function withPrefix(prefix: readonly string[], member: string): string {
  return prefix.length === 0 ? member : `${prefix.join(" ")} ${member}`;
}

/** The index after a member, skipping a method body or an initializer up to the next member. */
function afterMember(source: string, from: number, close: number): number {
  const index = skipTrivia(source, from);
  if (source[index] === "{") return scanBalanced(source, index, "{", "}");
  return skipToMemberEnd(source, index, close);
}

/** Skips one member whose shape the scanner does not understand. */
function skipToMemberEnd(source: string, from: number, close: number): number {
  let index = from;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  while (index < close) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets = Math.max(0, brackets - 1);
    else if (ch === "{") braces += 1;
    else if (ch === "}") {
      if (braces === 0 && parens === 0 && brackets === 0) return index;
      braces = Math.max(0, braces - 1);
    } else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (ch === ";" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) return index + 1;
    else if (ch === "\n" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      const next = skipTrivia(source, index + 1);
      if (next >= close || !continuesAt(source, index, next)) return next;
      index = next;
      continue;
    }
    index += 1;
  }
  return Math.min(index, close);
}

/** True when a line break sits inside a type or expression rather than between members. */
function continuesAt(source: string, newline: number, next: number): boolean {
  const nextChar = source[next] as string | undefined;
  if (nextChar !== undefined && "|&.=?:)]},".includes(nextChar)) return true;
  let previous = newline - 1;
  while (previous >= 0 && isWhitespace(source[previous] as string)) previous -= 1;
  const previousChar = source[previous] as string | undefined;
  return previousChar !== undefined && "|&=(,:[<>=?".includes(previousChar);
}

/** The end of a member's type: `;`, a newline that ends the member, `=`, or the body's close. */
function memberTypeEnd(source: string, from: number, close: number): number {
  let index = from;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  while (index < close) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets = Math.max(0, brackets - 1);
    else if (ch === "{") braces += 1;
    else if (ch === "}") {
      if (braces === 0 && parens === 0 && brackets === 0) return index;
      braces = Math.max(0, braces - 1);
    } else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (
      ch === "=" &&
      source[index + 1] !== ">" &&
      source[index - 1] !== "=" &&
      source[index - 1] !== ">" &&
      parens === 0 &&
      brackets === 0 &&
      braces === 0 &&
      angles === 0
    ) return index;
    else if (ch === ";" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) return index;
    else if (ch === "\n" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      const next = skipTrivia(source, index + 1);
      if (next >= close || !continuesAt(source, index, next)) return index;
      index = next;
      continue;
    }
    index += 1;
  }
  return Math.min(index, close);
}

/** The end of a type alias right-hand side: a top-level `;` or an uncontinued newline. */
function typeAliasEnd(source: string, from: number): number {
  return memberTypeEnd(source, from, source.length);
}

/** The end of a function's return type: the body's `{`, a `;`, or the enclosing close. */
function returnTypeEnd(source: string, from: number): number {
  let index = skipTrivia(source, from);
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  let previous = "";
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = endOfString(source, index, ch);
      previous = "string";
      continue;
    }
    if (ch === "`") {
      index = endOfTemplate(source, index);
      previous = "string";
      continue;
    }
    if (ch === "(") {
      parens += 1;
      previous = "(";
    } else if (ch === ")") {
      if (parens === 0) return index;
      parens -= 1;
      previous = ")";
    } else if (ch === "[") {
      brackets += 1;
      previous = "[";
    } else if (ch === "]") {
      if (brackets === 0) return index;
      brackets -= 1;
      previous = "]";
    } else if (ch === "{") {
      if (parens === 0 && brackets === 0 && braces === 0 && angles === 0 && endsType(previous)) return index;
      braces += 1;
      previous = "{";
    } else if (ch === "}") {
      if (braces === 0 && parens === 0 && brackets === 0) return index;
      braces -= 1;
      previous = "}";
    } else if (ch === "<") {
      angles += 1;
      previous = "<";
    } else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") {
      angles = Math.max(0, angles - 1);
      previous = ">";
    } else if (ch === ";" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      return index;
    } else if (ch === "\n" && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      const next = skipTrivia(source, index + 1);
      if (next >= source.length || !continuesAt(source, index, next)) return index;
      index = next;
      continue;
    } else if (isIdentifierStart(ch)) {
      const end = endOfIdentifier(source, index);
      previous = source.slice(index, end);
      index = end;
      continue;
    } else if (ch >= "0" && ch <= "9") {
      const end = endOfNumber(source, index, source.length);
      previous = source.slice(index, end);
      index = end;
      continue;
    } else if (!isWhitespace(ch)) {
      previous = ch;
    }
    index += 1;
  }
  return index;
}

/** Words after which a `{` opens a type literal rather than a function body. */
const TYPE_PREFIX_WORDS = new Set([
  "extends",
  "keyof",
  "typeof",
  "infer",
  "readonly",
  "new",
  "is",
  "asserts",
  "in",
  "out",
  "const",
]);

/** True when a token can end a type, so a following `{` starts a body. */
function endsType(token: string): boolean {
  if (token === "" || TYPE_PREFIX_WORDS.has(token)) return false;
  if (token === ")" || token === "]" || token === "}" || token === ">" || token === "string") return true;
  const last = token[token.length - 1] as string;
  return isIdentifierPart(last) || (last >= "0" && last <= "9");
}

/** The index just after a balanced pair, skipping strings, comments, templates, and regex literals. */
function scanBalanced(source: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new SourceSyntaxError(`Unterminated \`${openChar}\``, open);
}

/** The index just after a balanced angle-bracket list, where `=>` does not close it. */
function scanAngle(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
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
    if (ch === "<") depth += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new SourceSyntaxError("Unterminated generic parameter list", open);
}

/** Splits a parameter list on its top-level commas. */
function parseParams(source: string, start: number, end: number): SignatureParam[] {
  const params: SignatureParam[] = [];
  let index = start;
  let chunk = start;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;

  const add = (to: number): void => {
    if (skipTrivia(source, chunk) < to) params.push(paramOf(source, chunk, to));
  };

  while (index < end) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = close + 2;
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
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    else if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (ch === "," && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      add(index);
      chunk = index + 1;
    }
    index += 1;
  }
  add(end);
  return params;
}

/** Reads one parameter's name, type, optionality, and rest marker. */
function paramOf(source: string, start: number, end: number): SignatureParam {
  const text = canonical(source, start, end);
  let index = start;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  let colon = -1;
  let equals = -1;
  let question = -1;

  while (index < end) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = close + 2;
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
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    else if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "<") angles += 1;
    else if (ch === ">" && source[index - 1] !== "=" && source[index + 1] !== "=") angles = Math.max(0, angles - 1);
    else if (parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      if (ch === ":" && colon === -1) colon = index;
      else if (
        ch === "=" &&
        equals === -1 &&
        source[index + 1] !== ">" &&
        source[index + 1] !== "=" &&
        source[index - 1] !== "=" &&
        source[index - 1] !== ">" &&
        source[index - 1] !== "!"
      ) equals = index;
      else if (ch === "?" && question === -1 && colon === -1 && equals === -1) question = index;
    }
    index += 1;
  }

  const rest = source.slice(start, end).trimStart().startsWith("...");
  const nameEnd = question !== -1 ? question : colon !== -1 ? colon : equals !== -1 ? equals : end;
  const nameText = source.slice(start, nameEnd).trim().replace(/^\.\.\./, "");
  const name = IDENTIFIER.test(nameText) ? nameText : undefined;
  const type = colon === -1
    ? undefined
    : canonical(source, colon + 1, equals === -1 ? end : equals);
  return {
    text,
    ...(name === undefined ? {} : { name }),
    ...(type === undefined ? {} : { type }),
    optional: question !== -1 || equals !== -1,
    rest,
  };
}

/** A whole identifier, as documented code or a parameter name. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A number token: digits, letters, `_`, and `.` (for `0xFF`, `1_000`, and `1e3`). */
function endOfNumber(source: string, index: number, limit: number): number {
  let end = index + 1;
  while (end < limit) {
    const ch = source[end] as string;
    if (!isIdentifierPart(ch) && ch !== ".") break;
    end += 1;
  }
  return end;
}

/**
 * One canonical token of a signature.
 *
 * shortcut: types are compared as normalized text, so equivalent spellings such as `Array<T>` and `T[]`
 * are treated as drift; upgrade to a real type checker if that false positive matters.
 */
function canonical(source: string, start: number, end: number): string {
  const tokens: string[] = [];
  let index = start;
  while (index < end) {
    const ch = source[index] as string;
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw new SourceSyntaxError("Unterminated comment", index);
      index = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const string = normalizeString(source, index, ch);
      tokens.push(string.token);
      index = string.end;
      continue;
    }
    if (ch === "`") {
      const close = endOfTemplate(source, index);
      tokens.push(source.slice(index, Math.min(close, end)));
      index = close;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const close = endOfIdentifier(source, index);
      tokens.push(source.slice(index, close));
      index = close;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const close = endOfNumber(source, index, end);
      tokens.push(source.slice(index, close));
      index = close;
      continue;
    }
    tokens.push(ch);
    index += 1;
  }
  return joinTokens(tokens);
}

/** Joins canonical tokens, keeping words apart and dropping statement punctuation. */
function joinTokens(tokens: readonly string[]): string {
  let out = "";
  for (const token of tokens) {
    if (token === ";" || token === ",") continue;
    if (out !== "") {
      const previous = out[out.length - 1] as string;
      const first = token[0] as string;
      if (isWordCharacter(previous) && isWordCharacter(first)) out += " ";
    }
    out += token;
  }
  return out;
}

/** True for a character that belongs to a word token. */
function isWordCharacter(ch: string): boolean {
  return ch === "_" || ch === "$" || (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/** A string literal in one canonical quote style. */
function normalizeString(source: string, index: number, quote: string): { readonly token: string; readonly end: number } {
  const end = endOfString(source, index, quote);
  const body = source.slice(index + 1, end - 1);
  let out = "";
  for (let at = 0; at < body.length; at += 1) {
    const ch = body[at] as string;
    if (ch === "\\") {
      const next = body[at + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if (next === quote) {
        out += quote === '"' ? '\\"' : "'";
      } else if (next === '"') {
        out += '\\"';
      } else if (next === "'") {
        out += "'";
      } else {
        out += ch + next;
      }
      at += 1;
      continue;
    }
    out += ch === '"' ? '\\"' : ch;
  }
  return { token: `"${out}"`, end };
}


/** Reads inline code as a documented claim, or null when it names no symbol. */
export function documentedClaim(value: string): DocumentedClaim | null {
  const source = value.trim();
  if (source === "") return null;
  if (IDENTIFIER.test(source)) return { name: source, form: "name" };
  try {
    return parseDocumentedClaim(source);
  } catch (err) {
    if (!(err instanceof SourceSyntaxError)) throw err;
    const name = firstIdentifier(source);
    return name === null
      ? null
      : {
        name,
        form: "signature",
        unchecked: "the documented signature is not TypeScript the scanner can read",
      };
  }
}

/** The first identifier in a piece of inline code, for a claim whose shape is malformed. */
function firstIdentifier(source: string): string | null {
  const token = readIdentifier(source, skipTrivia(source, 0));
  return token === null ? null : token.name;
}

/** Reads the documented form: an optional declaration keyword, a name, and its API. */
function parseDocumentedClaim(source: string): DocumentedClaim | null {
  let index = skipTrivia(source, 0);
  let kind: DocumentedClaim["kind"];
  let async = false;

  for (;;) {
    const token = readIdentifier(source, index);
    if (token === null) break;
    if (token.name === "export" || token.name === "declare" || token.name === "default") {
      index = skipTrivia(source, token.end);
      continue;
    }
    if (token.name === "async") {
      const after = skipTrivia(source, token.end);
      if (readIdentifier(source, after) !== null) {
        async = true;
        index = after;
        continue;
      }
      break;
    }
    if (token.name === "function") {
      kind = "function";
      index = skipTrivia(source, token.end);
      if (source[index] === "*") index = skipTrivia(source, index + 1);
      break;
    }
    if (token.name === "class" || token.name === "interface") {
      kind = token.name;
      index = skipTrivia(source, token.end);
      break;
    }
    if (token.name === "type") {
      const after = skipTrivia(source, token.end);
      if (readIdentifier(source, after) !== null) {
        kind = "type";
        index = after;
        break;
      }
      break;
    }
    if (token.name === "const" || token.name === "let" || token.name === "var") {
      kind = "const";
      index = skipTrivia(source, token.end);
      break;
    }
    break;
  }

  const name = readIdentifier(source, skipTrivia(source, index));
  if (name === null) return null;

  if (kind === "function") return documentedFunction(source, kind, name, async);
  if (kind === "class" || kind === "interface") return documentedShape(source, kind, name);
  if (kind === "type") return documentedType(source, kind, name);
  if (kind === "const") return documentedConst(source, kind, name);

  const { generics, end: afterGenerics } = readGenerics(source, name.end);
  if (source[skipTrivia(source, afterGenerics)] !== "(") return null;

  const open = skipTrivia(source, afterGenerics);
  const { params, end } = readParams(source, open);
  const returns = documentedReturn(source, end);
  const tail = skipAfterDocumentedCall(source, end, returns !== undefined);
  if (tail !== null) return null;

  const signature: SymbolSignature = {
    text: `${name.name}${generics ?? ""}(${joinParams(params)})${returns === undefined ? "" : `: ${returns}`}`,
    line: 1,
    params,
    ...(generics === undefined ? {} : { generics }),
    ...(returns === undefined ? {} : { returns }),
  };
  if (generics !== undefined || returns !== undefined || params.some((param) => param.type !== undefined)) {
    return { name: name.name, form: "signature", signature };
  }
  const pattern = params.some((param) => param.text.startsWith("{") || param.text.startsWith("["));
  if (params.some((param) => param.rest)) {
    return { name: name.name, form: "call", signature, unchecked: "a spread argument does not state the signature" };
  }
  if (pattern) {
    return {
      name: name.name,
      form: "call",
      signature,
      unchecked: "a destructured argument does not state the parameter's type",
    };
  }
  return { name: name.name, form: "call", signature };
}

/** Reads a documented function signature. */
function documentedFunction(
  source: string,
  kind: "function",
  name: Identifier,
  async: boolean,
): DocumentedClaim {
  const tail = functionTail(source, name.end);
  return {
    name: name.name,
    kind,
    form: "signature",
    signature: {
      text: `${async ? "async " : ""}${name.name}${tail.generics ?? ""}(${joinParams(tail.params)})${tail.returns === undefined ? "" : `: ${tail.returns}`}`,
      line: 1,
      params: tail.params,
      ...(tail.generics === undefined ? {} : { generics: tail.generics }),
      ...(tail.returns === undefined ? {} : { returns: tail.returns }),
    },
  };
}

/** Reads a documented class or interface signature, including an optional body. */
function documentedShape(
  source: string,
  kind: "class" | "interface",
  name: Identifier,
): DocumentedClaim {
  const { generics, end } = readGenerics(source, name.end);
  const body = bodyOf(source, end);
  const heritage = body === null ? canonicalOrUndefined(source, end, source.length) : canonicalOrUndefined(source, end, body.open);
  const members = body === null ? undefined : parseMembers(source, body.open, body.close).members;
  return {
    name: name.name,
    kind,
    form: "signature",
    signature: {
      text: `${kind} ${name.name}${generics ?? ""}${heritage === undefined ? "" : ` ${heritage}`}${members === undefined ? "" : `{${members.join(";")}}`}`,
      line: 1,
      ...(generics === undefined ? {} : { generics }),
      ...(heritage === undefined ? {} : { heritage }),
      ...(members === undefined ? {} : { members }),
    },
  };
}

/** Reads a documented type alias signature. */
function documentedType(source: string, kind: "type", name: Identifier): DocumentedClaim {
  const { generics, end } = readGenerics(source, name.end);
  const equals = skipTrivia(source, end);
  const alias = source[equals] === "=" ? canonical(source, equals + 1, source.length) : undefined;
  return {
    name: name.name,
    kind,
    form: "signature",
    signature: {
      text: `type ${name.name}${generics ?? ""}${alias === undefined ? "" : ` = ${alias}`}`,
      line: 1,
      ...(generics === undefined ? {} : { generics }),
      ...(alias === undefined || alias === "" ? {} : { alias }),
    },
  };
}

/** Reads a documented const's annotated type. */
function documentedConst(source: string, kind: "const", name: Identifier): DocumentedClaim {
  let index = skipTrivia(source, name.end);
  let annotation: string | undefined;
  if (source[index] === ":") annotation = canonical(source, index + 1, source.length);
  return {
    name: name.name,
    kind,
    form: "signature",
    signature: {
      text: `const ${name.name}${annotation === undefined ? "" : `: ${annotation}`}`,
      line: 1,
      ...(annotation === undefined || annotation === "" ? {} : { alias: annotation }),
    },
  };
}

/** The return type after a documented call's `)`, when it is written. */
function documentedReturn(source: string, afterParams: number): string | undefined {
  const colon = skipTrivia(source, afterParams);
  if (source[colon] !== ":") return undefined;
  const text = canonical(source, colon + 1, source.length);
  return text === "" ? undefined : text;
}

/** The index of the first non-trivia character after a call, or null when nothing but `;` remains. */
function skipAfterDocumentedCall(source: string, afterParams: number, hasReturn: boolean): number | null {
  if (hasReturn) return null;
  let index = skipTrivia(source, afterParams);
  if (index < source.length && source[index] === ";") index = skipTrivia(source, index + 1);
  return index >= source.length ? null : index;
}

/** Compares a documented signature against an exported declaration. */
export function checkDocumentedSignature(claim: DocumentedClaim, symbol: ExportedSymbol): SignatureCheck {
  if (claim.form === "name") return { state: "match" };
  if (claim.unchecked !== undefined) return { state: "unchecked", reason: claim.unchecked };
  const documented = claim.signature;
  if (documented === undefined) return { state: "unchecked", reason: "the documented form has no readable signature" };

  const actuals = symbol.signatures ?? [];
  if (actuals.length === 0) {
    return {
      state: "unchecked",
      reason: symbol.unchecked ?? `a ${symbol.kind} declaration has no comparable signature`,
    };
  }

  let unchecked: string | undefined;
  for (const actual of actuals) {
    const check = compareSignature(documented, actual, claim, symbol.unchecked);
    if (check.state === "match") return check;
    if (check.state === "unchecked") unchecked ??= check.reason;
  }
  unchecked ??= symbol.unchecked;
  return unchecked === undefined ? { state: "mismatch" } : { state: "unchecked", reason: unchecked };
}

/** Compares one documented signature with one actual signature. */
function compareSignature(
  documented: SymbolSignature,
  actual: SymbolSignature,
  claim: DocumentedClaim,
  unchecked: string | undefined,
): SignatureCheck {
  if (claim.kind === "class" || claim.kind === "interface") {
    if (actual.text.startsWith(`${claim.kind} `) === false) return { state: "mismatch" };
    return compareShape(documented, actual, unchecked);
  }
  if (claim.kind === "type") {
    if (actual.text.startsWith("type ") === false) return { state: "mismatch" };
    return compareAlias(documented, actual, "the type alias");
  }
  if (claim.kind === "const") {
    if (actual.text.startsWith("const ") === false) return { state: "mismatch" };
    return compareAlias(documented, actual, "the declaration");
  }
  return compareFunction(documented, actual, claim.form);
}

/** Compares function parameters, generics, and a return type. */
function compareFunction(documented: SymbolSignature, actual: SymbolSignature, form: DocumentedClaim["form"]): SignatureCheck {
  if (actual.params === undefined) {
    return actual.text.startsWith("class ")
      ? { state: "unchecked", reason: "a class constructor is not compared" }
      : { state: "mismatch" };
  }

  const documentedParams = (documented.params ?? []).filter((param) => param.name !== "this");
  const actualParams = actual.params.filter((param) => param.name !== "this");
  const restAt = actualParams.findIndex((param) => param.rest);
  const minimum = actualParams.findIndex((param) => param.optional || param.rest);
  const minimumArgs = minimum === -1 ? actualParams.length : minimum;
  const maximumArgs = restAt === -1 ? actualParams.length : Number.POSITIVE_INFINITY;

  if (documentedParams.some((param) => param.rest) && restAt === -1) return { state: "mismatch" };
  if (documentedParams.length < minimumArgs || documentedParams.length > maximumArgs) return { state: "mismatch" };

  if (documented.generics !== undefined) {
    if (actual.generics === undefined || actual.generics !== documented.generics) return { state: "mismatch" };
  }

  if (form === "signature") {
    for (let index = 0; index < documentedParams.length; index += 1) {
      const documentedParam = documentedParams[index] as SignatureParam;
      const actualParam = actualParams[index];
      if (actualParam === undefined) {
        if (documentedParam.type === undefined) continue;
        return { state: "unchecked", reason: "a parameter past the declared rest parameter has no type to compare" };
      }
      if (documentedParam.optional && !actualParam.optional && !actualParam.rest) return { state: "mismatch" };
      if (documentedParam.rest && !actualParam.rest) return { state: "mismatch" };
      if (documentedParam.type !== undefined) {
        if (actualParam.type === undefined) {
          return { state: "unchecked", reason: `the parameter at position ${index + 1} has no type annotation` };
        }
        if (actualParam.type !== documentedParam.type) return { state: "mismatch" };
      }
    }

    if (documented.returns !== undefined) {
      if (actual.returns === undefined) {
        return { state: "unchecked", reason: "the declaration has no return type annotation to compare" };
      }
      if (actual.returns !== documented.returns) return { state: "mismatch" };
    }
  }

  return { state: "match" };
}

/** Compares a class or interface header and the members the documentation states. */
function compareShape(documented: SymbolSignature, actual: SymbolSignature, unchecked: string | undefined): SignatureCheck {
  if (documented.generics !== undefined) {
    if (actual.generics === undefined || actual.generics !== documented.generics) return { state: "mismatch" };
  }
  if (documented.heritage !== undefined) {
    if (actual.heritage === undefined || actual.heritage !== documented.heritage) return { state: "mismatch" };
  }
  if (documented.members !== undefined) {
    if (actual.members === undefined) {
      return { state: "unchecked", reason: "the members of this declaration could not be extracted" };
    }
    for (const member of documented.members) {
      if (!actual.members.includes(member)) {
        return unchecked === undefined ? { state: "mismatch" } : { state: "unchecked", reason: unchecked };
      }
    }
  }
  return { state: "match" };
}

/** Compares a type alias's right-hand side or a const's annotated type. */
function compareAlias(documented: SymbolSignature, actual: SymbolSignature, what: string): SignatureCheck {
  if (documented.generics !== undefined) {
    if (actual.generics === undefined || actual.generics !== documented.generics) return { state: "mismatch" };
  }
  if (documented.alias === undefined) return { state: "unchecked", reason: `${what} has no documented type` };
  if (actual.alias === undefined) {
    return { state: "unchecked", reason: `${what} has no type annotation to compare` };
  }
  return actual.alias === documented.alias ? { state: "match" } : { state: "mismatch" };
}
/** Sorts by line, then name, and merges the declarations of a repeated export name. */
function sortSymbols(symbols: readonly ExportedSymbol[]): ExportedSymbol[] {
  const sorted = [...symbols].sort((a, b) => a.line - b.line || compareCodePoints(a.name, b.name));
  const merged: ExportedSymbol[] = [];
  const byName = new Map<string, number>();
  for (const symbol of sorted) {
    const at = byName.get(symbol.name);
    if (at === undefined) {
      byName.set(symbol.name, merged.length);
      merged.push(symbol);
      continue;
    }
    const kept = merged[at] as ExportedSymbol;
    merged[at] = mergeSymbol(kept, symbol);
  }
  return merged;
}

/** One symbol's API: the first declaration's kind and line, every signature, and any unchecked part. */
function mergeSymbol(first: ExportedSymbol, next: ExportedSymbol): ExportedSymbol {
  const signatures = [...(first.signatures ?? []), ...(next.signatures ?? [])];
  const checked = signatures.filter(
    (signature, index) =>
      signatures.findIndex(
        (other) => other.line === signature.line && other.text === signature.text,
      ) === index,
  );
  const unchecked = first.unchecked ?? next.unchecked;
  return {
    name: first.name,
    kind: first.kind,
    line: first.line,
    ...(checked.length === 0 ? {} : { signatures: checked }),
    ...(unchecked === undefined ? {} : { unchecked }),
  };
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
