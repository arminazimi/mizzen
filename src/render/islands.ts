import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import type { Island } from "../contracts/render.ts";

/**
 * Client islands: a component's `client.ts` becomes a plain ES module, minified, and a page
 * loads only the islands of the components it uses (ADR 0022, rule 3).
 *
 * Types are removed with Node's type stripping, so only erasable syntax is allowed (ADR 0022, rule 1).
 * Minifying needs no dependency: the engine's runtime dependencies stay as ADR 0022 lists them.
 */

type Kind = "word" | "number" | "string" | "template" | "regex" | "punct";

interface Token {
  readonly kind: Kind;
  readonly text: string;
  /** Whitespace or a comment came before this token. */
  readonly space: boolean;
  /** A line break came before this token. */
  readonly newline: boolean;
}

/** Characters that can make up an identifier, a keyword, or a unicode escape in a word. */
const WORD = /[\p{ID_Continue}$\\\u200c\u200d]/u;

/** Keywords after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Punctuators that end an operand: a `/` after them is a division. */
const ENDS_OPERAND = new Set([")", "]", "}", "++", "--"]);

/** Tokens that may follow a line break without a semicolon in front of them. */
const CLOSES = new Set([")", "]", "}", ";", ","]);

function isLineBreak(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function unterminated(what: string): never {
  throw new Error(`Unterminated ${what}.`);
}

/** Removes TypeScript types from `source`, leaving plain JavaScript. Throws, naming `file`, on syntax Node cannot strip. */
export function stripTypes(source: string, file: string): string {
  try {
    return stripTypeScriptTypes(source, { mode: "strip", sourceUrl: file });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot strip types from "${file}": ${detail}.`);
  }
}

/** Returns the index just after the string literal that starts at `start`. */
function scanString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      // A backslash before CRLF continues the string across both characters.
      if (src[i - 1] === "\r" && src[i] === "\n") i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n" || ch === "\r") unterminated("string");
    i += 1;
  }
  return unterminated("string");
}

/** Returns the index of the line break that ends the line comment at `start` (or the end of the source). */
function skipLineComment(src: string, start: number): number {
  let i = start + 2;
  while (i < src.length && !isLineBreak(src[i]!)) i += 1;
  return i;
}

/** Returns the index just after the block comment at `start`. */
function skipBlockComment(src: string, start: number): number {
  const end = src.indexOf("*/", start + 2);
  if (end < 0) unterminated("comment");
  return end + 2;
}

/**
 * Returns the index just after the `}` that closes a `${` expression whose body starts at `start`.
 * The body is tokenized like code, so strings, comments, and regular expressions inside it do not
 * hide the closing brace.
 */
function skipTemplateExpression(src: string, start: number): number {
  let depth = 0;
  let prev: Token | undefined;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (isLineBreak(ch) || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i);
      continue;
    }
    if (ch === "}" && depth === 0) return i + 1;
    const scanned = scanToken(src, i, prev);
    if (scanned.kind === "punct") {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    prev = { kind: scanned.kind, text: src.slice(i, scanned.end), space: false, newline: false };
    i = scanned.end;
  }
  return unterminated("template expression");
}

/** Returns the index just after the template literal at `start`. Its text is kept as written. */
function scanTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && src[i + 1] === "{") {
      i = skipTemplateExpression(src, i + 2);
      continue;
    }
    i += 1;
  }
  return unterminated("template");
}

/** Returns the index just after the regular expression literal at `start`, flags included. */
function scanRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  for (;;) {
    if (i >= src.length) unterminated("regular expression");
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (isLineBreak(ch)) unterminated("regular expression");
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i += 1;
      break;
    }
    i += 1;
  }
  while (i < src.length && WORD.test(src[i]!)) i += 1;
  return i;
}

/** Returns the index just after the numeric literal at `start`. Greedy on purpose: it only decides spacing. */
function scanNumber(src: string, start: number): number {
  const radix = /^0[xXoObB]/.test(src.slice(start, start + 2));
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (/[0-9A-Za-z_.]/.test(ch)) i += 1;
    else if ((ch === "+" || ch === "-") && !radix && /[eE]/.test(src[i - 1]!)) i += 1;
    else break;
  }
  return i;
}

/** The code point at `index`, as a string (a surrogate pair counts as one). */
function codePointAt(src: string, index: number): string {
  return String.fromCodePoint(src.codePointAt(index) ?? 0);
}

/** Returns the index just after the word (identifier or keyword) at `start`. */
function scanWord(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const ch = codePointAt(src, i);
    if (!WORD.test(ch)) break;
    i += ch.length;
  }
  return i;
}

/** Whether a `/` after `prev` starts a regular expression literal. */
function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "word") return BEFORE_EXPRESSION.has(prev.text);
  if (prev.kind === "punct") return !ENDS_OPERAND.has(prev.text);
  return false;
}

interface Scanned {
  readonly kind: Kind;
  /** Index just after the token that starts at the scanned position. */
  readonly end: number;
}

/** Scans the one token that starts at `i`; `prev` is the token before it (decides `/` as division or regex). */
function scanToken(src: string, i: number, prev: Token | undefined): Scanned {
  const ch = src[i]!;
  if (ch === '"' || ch === "'") return { kind: "string", end: scanString(src, i) };
  if (ch === "`") return { kind: "template", end: scanTemplate(src, i) };
  if (ch === "/" && regexAllowed(prev)) return { kind: "regex", end: scanRegex(src, i) };
  if (isDigit(ch) || (ch === "." && isDigit(src[i + 1]))) return { kind: "number", end: scanNumber(src, i) };
  if (WORD.test(codePointAt(src, i))) return { kind: "word", end: scanWord(src, i) };
  if ((ch === "+" || ch === "-") && src[i + 1] === ch) return { kind: "punct", end: i + 2 };
  return { kind: "punct", end: i + codePointAt(src, i).length };
}

/** Splits JavaScript into tokens, recording the whitespace and line breaks before each one. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let space = false;
  let newline = false;
  let prev: Token | undefined;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (isLineBreak(ch)) {
      newline = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      space = true;
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      space = true;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = skipBlockComment(src, i);
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, end))) newline = true;
      else space = true;
      i = end;
      continue;
    }

    const scanned = scanToken(src, i, prev);
    const token: Token = { kind: scanned.kind, text: src.slice(i, scanned.end), space, newline };
    tokens.push(token);
    prev = token;
    space = false;
    newline = false;
    i = scanned.end;
  }
  return tokens;
}

/** Whether `prev` ends an operand, so a line break after it may end the statement (automatic semicolon insertion). */
function endsOperand(prev: Token): boolean {
  return prev.kind !== "punct" || ENDS_OPERAND.has(prev.text);
}

/** Whether two tokens that were separated by whitespace need it to stay two tokens. */
function needsSpace(prev: Token, next: Token): boolean {
  const chars = [...prev.text];
  const last = chars[chars.length - 1]!;
  const first = codePointAt(next.text, 0);
  if (WORD.test(last) && WORD.test(first)) return true;
  if ((last === "+" || last === "-" || last === "/") && last === first) return true;
  if (prev.kind === "number" && next.text === ".") return true;
  return false;
}

/**
 * Minifies plain JavaScript: removes comments and indentation and keeps only the spaces and line
 * breaks the grammar needs. Strings, template literals, and regular expressions are copied as written.
 * A line break is kept wherever automatic semicolon insertion could apply.
 */
export function minifyJs(source: string): string {
  let out = "";
  let prev: Token | undefined;
  for (const token of tokenize(source)) {
    if (prev !== undefined) {
      if (token.newline && endsOperand(prev) && !CLOSES.has(token.text)) out += "\n";
      else if ((token.space || token.newline) && needsSpace(prev, token)) out += " ";
    }
    out += token.text;
    prev = token;
  }
  return out;
}

/** Reads a client island from disk and returns the browser module: types stripped, then minified. */
export async function buildIsland(file: string): Promise<string> {
  const stripped = stripTypes(await readFile(file, "utf8"), file);
  try {
    return minifyJs(stripped);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot minify "${file}": ${detail}`);
  }
}

/** A JavaScript string literal for `value` that cannot close a `<script>` element. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function attrValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The one `<script type="module">` a page needs for its islands: it imports each island once, in order.
 * Returns an empty string when the page uses no island, so such a page has no script tag.
 * Pass `nonce` when the site's Content Security Policy requires a nonce for inline scripts.
 */
export function islandScript(islands: readonly Island[], nonce?: string): string {
  const srcs = [...new Set(islands.map((island) => island.src))];
  if (srcs.length === 0) return "";
  const imports = srcs.map((src) => `import ${scriptString(src)};`).join("");
  const nonceAttr = nonce === undefined ? "" : ` nonce="${attrValue(nonce)}"`;
  return `<script type="module"${nonceAttr}>${imports}</script>`;
}

/** Folder under the output that island modules go to. */
export const ISLAND_DIR = "assets/theme/islands";

/** A relative `from "./x.ts"`, `import "./x.ts"`, or `import("./x.ts")` specifier in stripped source. */
const RELATIVE_SPECIFIER = /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

/** Where the browser module for the theme file `rel` (relative to the theme root) is written, relative to the output. */
export function islandPath(rel: string): string {
  return `${ISLAND_DIR}/${rel.split(sep).join("/").replace(/\.ts$/, ".js")}`;
}

/** The URL of an island's entry module under `base` (the site's base path, `""` or `/slipway`). */
export function islandUrl(base: string, clientRel: string): string {
  return `${base}/${islandPath(clientRel)}`;
}

/**
 * Builds the browser modules for the given client files, and every theme file they import with a relative path.
 * Each file becomes its own module (types stripped, `.ts` specifiers pointing at `.js`, minified), written where
 * {@link islandPath} says, so a file two islands share is built once and the browser caches it. Returns output path to
 * source text. A bare specifier (a package) is an error: the browser could not resolve it.
 */
export async function buildIslandModules(themeRoot: string, clients: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = clients.map((rel) => resolve(themeRoot, rel));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(themeRoot, file);
    if (rel.startsWith("..")) throw new Error(`Island file "${file}" is outside the theme folder.`);
    const stripped = stripTypes(await readFile(file, "utf8"), file);
    const rewritten = stripped.replace(RELATIVE_SPECIFIER, (_all, head: string, quote: string, spec: string) => {
      queue.push(resolve(dirname(file), spec));
      return `${head}${quote}${spec.replace(/\.ts$/, ".js")}${quote}`;
    });
    const bare = /(?:\bfrom|^\s*import)\s*["']([^."'/][^"']*)["']/m.exec(rewritten);
    if (bare) throw new Error(`Island "${rel}" imports "${bare[1]}", which a browser cannot resolve; import a relative file instead.`);
    try {
      out.set(islandPath(rel), minifyJs(rewritten));
    } catch (err) {
      throw new Error(`Cannot minify "${rel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
