import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Nodes } from "mdast";
import type { Diagnostic, Page, SourcePos } from "../contracts/index.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { codeRefsOf, type CodeRef } from "./code-refs.ts";
import { exportedSymbols, type ExportedSymbol } from "./symbols.ts";

/**
 * Compares what a page claims about the code with what the code holds (N09), and reports each claim the
 * code no longer satisfies.
 *
 * A page makes a claim wherever N07 finds a `path:line` code reference. A reference to a TypeScript file
 * also names a symbol when the paragraph that holds it uses inline code for one:
 *
 * - A claim is inline code whose whole trimmed text is one identifier, optionally ending in `()`:
 *   `` `buildDocs()` `` claims `buildDocs`, and `` `Widget` `` claims `Widget`. Anything else, such as
 *   `` `npm install` `` or `` `foo.bar` ``, claims no symbol; neither does a bare lowercase word such as
 *   `` `node` `` unless the target file exports that name. This keeps commands out of the comparison.
 * - When several claims sit in one paragraph, the one nearest the reference (by line, then column, then
 *   name in code-point order) names the symbol a diagnostic reports; any claim that satisfies the
 *   reference is enough.
 * - A cited line range (`path:10-14`) is satisfied by any declaration line the range reaches.
 *
 * The reference is satisfied when:
 *
 * - its target is a non-TypeScript file and every cited line is within it, which checks existence and
 *   range only; or
 * - the cited line is within `tolerance` lines (default 5) of a claimed symbol's declaration; or
 * - no symbol is claimed and some exported declaration is within `tolerance` lines of the cited range.
 *
 * Otherwise it reports:
 *
 * - `drift.missing-file`, `drift.line-out-of-range`, or `drift.outside-root` when the target cannot be
 *   checked at all;
 * - `drift.moved-symbol` when the claimed symbol exists but its declaration moved outside the tolerance,
 *   or, with no claim, when the file exports symbols but none are near the cited line. The message names
 *   the symbol and its actual line.
 * - `drift.missing-symbol` when the page names a symbol the file no longer exports, or when a cited
 *   TypeScript file exports nothing. Inline code that only looks like a symbol (camelCase, PascalCase,
 *   or a call) counts as a claim, so a renamed lowercase-only name is not detected; the page still
 *   passes when another declaration sits at the cited line.
 *
 * Paths resolve inside `root` and never outside it: a target that resolves outside the root, including
 * one that uses a symbolic link to leave it, is refused with `drift.outside-root` and never read. A
 * TypeScript file that N08 cannot scan is treated as exporting nothing; the scan's own diagnostic is
 * N08's to report.
 *
 * ## Evidence identity
 *
 * A finding only means something for the exact content and source bytes it was computed from. Every
 * comparison therefore also returns a {@link DriftIdentity}: a hash of the page's Markdown, body line,
 * and tolerance, plus a hash of each cited file (or a marker saying it was missing or outside the root).
 * A stored report can compare that identity with the current files and refuse evidence that no longer
 * matches instead of reusing it; {@link driftContentOf} gives the content half without reading anything.
 *
 * `compareClaims` and `comparePages` read files under `root` and write nothing; they keep no state
 * between calls. Diagnostics come in the order of `pages`, then source line and column, then check ID
 * and message, so two runs over the same arguments agree.
 */

/** The default number of lines a cited line may miss a declaration by. */
export const DEFAULT_TOLERANCE = 5;

/** Where to look for the code a page points at, and how far a citation may drift. */
export interface CompareOptions {
  /** Site root the reference paths resolve from. A reference never reads outside it. */
  readonly root: string;
  /**
   * How many lines the cited line may differ from a declaration's line before it counts as moved.
   * Defaults to {@link DEFAULT_TOLERANCE}. A negative or non-finite value is treated as `0`.
   */
  readonly tolerance?: number;
}

/** A citation target that was read, or why it could not be. */
type Target =
  | { readonly kind: "outside" }
  | { readonly kind: "missing"; readonly detail: string }
  | { readonly kind: "text"; readonly text: string; readonly symbols: readonly ExportedSymbol[] | null };

/** A box in a page's source: lines and columns are 1-based and the end is inclusive, as in `SourcePos`. */
interface Box {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** One inline-code claim inside a paragraph. */
interface Claim {
  /** The identifier the inline code names. */
  readonly name: string;
  /** True when the inline code ended in `()`, which marks it as a call. */
  readonly call: boolean;
  /** Line of the inline-code node. */
  readonly line: number;
  /** Column of the inline-code node. */
  readonly column: number;
}

/** A paragraph that can hold claims, with every inline code in it. */
interface Paragraph extends Box {
  readonly claims: readonly Claim[];
}

/** A whole identifier, without a call's parentheses. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A TypeScript source file, including `.d.ts`, `.mts`, `.cts`, and `.tsx`. */
const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/i;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the text, as 64 lowercase hex characters. */
function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The identity of the page content and cited sources a comparison was computed from. Two comparisons
 * with the same identity read the same bytes and used the same tolerance, so one cannot replace the
 * other's evidence by accident.
 */
export interface DriftIdentity {
  /** SHA-256 over the page's Markdown, its body line, and the tolerance used. */
  readonly content: string;
  /**
   * Per cited path: the SHA-256 of the file's bytes when it was read, or `"missing"` when it could not
   * be read, or `"outside"` when it resolves outside the root. Keys are repository-relative paths in
   * code-point order.
   */
  readonly sources: Readonly<Record<string, string>>;
}

/** One page's comparison: what it cites, what the files answered, and the identity behind both. */
export interface ClaimComparison {
  /** The page's source file, relative to the repository root. */
  readonly file: string;
  /** Every code reference the page makes, in document order. */
  readonly references: readonly CodeRef[];
  /** The findings, sorted by line, column, check ID, and message. */
  readonly diagnostics: readonly Diagnostic[];
  /** The content and source identities the findings were computed from. */
  readonly identity: DriftIdentity;
}

/** The content half of a page's drift identity: its Markdown, body line, and the tolerance used. */
export function driftContentOf(page: Page, tolerance?: number): string {
  return hashOf(`mizzen-drift-content\u0000${normalizeTolerance(tolerance)}\u0000${page.source.line}\u0000${page.markdown}`);
}

/** The sources of one page, keyed and ordered by code point. */
function sourcesOf(paths: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [...paths.keys()].sort(byCodePoint)) out[path] = paths.get(path) as string;
  return out;
}

/**
 * Every page's comparison, in input order. Reads only; `root` is the site root the reference paths
 * resolve from. The identity a page returns covers the bytes its findings were judged against, so a
 * caller can store the findings and later tell whether they still hold.
 */
export async function comparePages(
  pages: readonly Page[],
  options: CompareOptions,
): Promise<ClaimComparison[]> {
  const root = resolve(options.root);
  const rootReal = await realpathOr(root);
  const tolerance = normalizeTolerance(options.tolerance);
  const targets = new Map<string, Target>();
  const comparisons: ClaimComparison[] = [];

  for (const page of pages) {
    const references = await codeRefsOf(page);
    const sources = new Map<string, string>();
    for (const ref of references) {
      if (sources.has(ref.path)) continue;
      const target = await targetOf(ref.path, root, rootReal, targets);
      sources.set(ref.path, target.kind === "text" ? hashOf(target.text) : target.kind);
    }

    const diagnostics: Diagnostic[] = [];
    if (references.length > 0) {
      const paragraphs = paragraphsOf(await parseMarkdown(page.markdown, page.source.line));
      for (const ref of references) {
        const target = await targetOf(ref.path, root, rootReal, targets);
        const found = judge(ref, target, paragraphFor(ref.pos, paragraphs), tolerance);
        if (found !== null) diagnostics.push(found);
      }
      diagnostics.sort(compareDiagnostics);
    }

    comparisons.push({
      file: page.source.file,
      references,
      diagnostics,
      identity: { content: driftContentOf(page, tolerance), sources: sourcesOf(sources) },
    });
  }

  return comparisons;
}

/**
 * Every claim and every miss in the pages, in the input page order, then source line and column, then
 * check ID and message. Reads only; `root` is the site root the reference paths resolve from. Callers
 * that need to store the findings against the bytes they came from use {@link comparePages} instead.
 */
export async function compareClaims(
  pages: readonly Page[],
  options: CompareOptions,
): Promise<Diagnostic[]> {
  const comparisons = await comparePages(pages, options);
  return comparisons.flatMap((comparison) => comparison.diagnostics);
}

/** Reads one target, once per path, refusing anything outside the root. */
async function targetOf(
  path: string,
  root: string,
  rootReal: string,
  cache: Map<string, Target>,
): Promise<Target> {
  const known = cache.get(path);
  if (known !== undefined) return known;

  const target = await readTarget(path, root, rootReal);
  cache.set(path, target);
  return target;
}

/** Resolves, confines, and reads one file, or says why it was not read. */
async function readTarget(path: string, root: string, rootReal: string): Promise<Target> {
  // N07 already normalizes a path inside the root; this keeps a future caller from widening it.
  if (isAbsolute(path) || path.split("/").includes("..")) return { kind: "outside" };

  const absolute = resolve(root, path);
  if (!within(root, absolute)) return { kind: "outside" };

  let real: string;
  try {
    real = await realpath(absolute);
  } catch (err) {
    return { kind: "missing", detail: missingDetail(err) };
  }
  if (!within(rootReal, real)) return { kind: "outside" };

  let text: string;
  try {
    text = await readFile(real, "utf8");
  } catch (err) {
    return { kind: "missing", detail: missingDetail(err) };
  }

  return { kind: "text", text, symbols: TYPESCRIPT.test(path) ? exportedSymbols(text, { file: path }).symbols : null };
}

/** True when `target` is `base` or inside it, comparing the paths as given. */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path, or the path itself when it does not resolve (a missing root, for example). */
async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** The deterministic tail of a missing-file message. */
function missingDetail(error: unknown): string {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "does not exist";
  return code === undefined ? "cannot be read" : `cannot be read (${code})`;
}

/** The `code` of a Node fs error, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The tolerance as a whole number of lines, never negative. */
function normalizeTolerance(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOLERANCE;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

/** Every paragraph in a parsed page, with the inline code it holds. */
function paragraphsOf(tree: Nodes): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  collectParagraphs(tree, paragraphs);
  return paragraphs;
}

/** Walks a parsed page in document order, adding each positioned paragraph. */
function collectParagraphs(node: Nodes, out: Paragraph[]): void {
  if (node.type === "paragraph" && node.position) {
    out.push({
      startLine: node.position.start.line,
      startColumn: node.position.start.column,
      endLine: node.position.end.line,
      endColumn: node.position.end.column,
      claims: claimsIn(node),
    });
  }
  if ("children" in node) for (const child of node.children) collectParagraphs(child, out);
}

/** Every inline code in one paragraph, in document order. */
function claimsIn(node: Nodes): Claim[] {
  const claims: Claim[] = [];
  collectClaims(node, claims);
  return claims;
}

/** Reads inline code by name; other inline nodes are walked for code nested in them. */
function collectClaims(node: Nodes, out: Claim[]): void {
  if (node.type === "inlineCode") {
    const claim = claimOf(node.value, node.position?.start.line, node.position?.start.column);
    if (claim !== null) out.push(claim);
    return;
  }
  if ("children" in node) for (const child of node.children) collectClaims(child, out);
}

/** Reads one inline code's text as a claim, or null when it does not name an identifier. */
function claimOf(value: string, line: number | undefined, column: number | undefined): Claim | null {
  if (line === undefined || column === undefined) return null;
  const text = value.trim();
  const call = text.endsWith("()");
  const name = call ? text.slice(0, -2) : text;
  if (!IDENTIFIER.test(name)) return null;
  return { name, call, line, column };
}

/** The paragraph whose span holds `pos`, if any. */
function paragraphFor(pos: SourcePos, paragraphs: readonly Paragraph[]): Paragraph | undefined {
  for (const paragraph of paragraphs) {
    if (atOrAfter(pos, paragraph) && atOrBefore({ line: pos.endLine, column: pos.endColumn }, paragraph)) {
      return paragraph;
    }
  }
  return undefined;
}

/** True when the start of `pos` is at or after the paragraph's start. */
function atOrAfter(pos: SourcePos, box: Box): boolean {
  return pos.line > box.startLine || (pos.line === box.startLine && pos.column >= box.startColumn);
}

/** True when a point is at or before the box's end. */
function atOrBefore(point: { readonly line: number; readonly column: number }, box: Box): boolean {
  return point.line < box.endLine || (point.line === box.endLine && point.column <= box.endColumn);
}

/** The one diagnostic a reference earns, or null when the page and the code agree. */
function judge(ref: CodeRef, target: Target, paragraph: Paragraph | undefined, tolerance: number): Diagnostic | null {
  if (target.kind === "outside") return outsideRoot(ref);
  if (target.kind === "missing") return missingFile(ref, target.detail);
  if (target.symbols === null) return checkLines(ref, target.text);
  return checkSymbols(ref, target.symbols, paragraph?.claims ?? [], tolerance);
}

/** A reference to a path outside the root is refused without being read. */
function outsideRoot(ref: CodeRef): Diagnostic {
  return {
    id: "drift.outside-root",
    severity: "warning",
    message: `The reference to "${ref.path}" points outside the site root, so it was not read.`,
    pos: ref.pos,
    help: "Cite a file inside the site, or start the path with `/` to anchor it at the site root.",
  };
}

/** A reference whose file cannot be read. */
function missingFile(ref: CodeRef, detail: string): Diagnostic {
  return {
    id: "drift.missing-file",
    severity: "warning",
    message: `Cannot check the reference to "${ref.path}": the file ${detail}.`,
    pos: ref.pos,
    help: "Update the path or restore the file.",
  };
}

/** A non-TypeScript file only has to exist and to be long enough. */
function checkLines(ref: CodeRef, text: string): Diagnostic | null {
  const count = lineCount(text);
  const last = ref.endLine ?? ref.line;
  if (ref.line <= count && last <= count) return null;
  return {
    id: "drift.line-out-of-range",
    severity: "warning",
    message: `"${ref.path}" has ${count} line${count === 1 ? "" : "s"}, but this reference cites line ${last}.`,
    pos: ref.pos,
    help: "Point the reference at a line the file has.",
  };
}

/** The number of lines in a text; an empty file has none and a trailing newline adds no empty line. */
function lineCount(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") newlines += 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Compares a TypeScript citation with the file's exports. */
function checkSymbols(
  ref: CodeRef,
  symbols: readonly ExportedSymbol[],
  claims: readonly Claim[],
  tolerance: number,
): Diagnostic | null {
  const exported = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const named = claims.filter((claim) => exported.has(claim.name));
  const candidates = claims.filter((claim) => exported.has(claim.name) || looksLikeSymbol(claim));

  if (named.length > 0) {
    for (const claim of named) {
      const symbol = exported.get(claim.name);
      if (symbol !== undefined && distanceTo(ref, symbol.line) <= tolerance) return null;
    }
    const claim = nearestClaim(named, ref);
    const symbol = exported.get(claim.name);
    if (symbol === undefined) return null;
    return movedClaim(ref, claim.name, symbol.line, tolerance);
  }

  if (candidates.length > 0) {
    return missingClaim(ref, nearestClaim(candidates, ref).name);
  }

  if (symbols.length === 0) return noSymbols(ref);

  for (const symbol of symbols) {
    if (distanceTo(ref, symbol.line) <= tolerance) return null;
  }
  return movedWithoutClaim(ref, nearestSymbol(symbols, ref), tolerance);
}

/** True for inline code that reads as a symbol even when the file exports no such name. */
function looksLikeSymbol(claim: Claim): boolean {
  if (claim.call) return true;
  // camelCase and PascalCase only, so an environment variable or a command stays out of the comparison.
  return /^[a-z][A-Za-z0-9]*[A-Z]/.test(claim.name) || /^[A-Z][a-z]/.test(claim.name);
}

/** How many lines separate a declaration from the cited range; zero when the range reaches it. */
function distanceTo(ref: CodeRef, line: number): number {
  const last = ref.endLine ?? ref.line;
  if (line < ref.line) return ref.line - line;
  if (line > last) return line - last;
  return 0;
}

/** The claim nearest the reference, by line and column, then name. */
function nearestClaim(claims: readonly Claim[], ref: CodeRef): Claim {
  let best = claims[0] as Claim;
  let bestDistance = claimDistance(best, ref);
  for (const claim of claims) {
    const distance = claimDistance(claim, ref);
    if (distance < bestDistance || (distance === bestDistance && byCodePoint(claim.name, best.name) < 0)) {
      best = claim;
      bestDistance = distance;
    }
  }
  return best;
}

/** A rough distance from a claim to the reference: lines first, then columns. */
function claimDistance(claim: Claim, ref: CodeRef): number {
  return Math.abs(claim.line - ref.pos.line) * 1_000_000 + Math.abs(claim.column - ref.pos.column);
}

/** The exported symbol nearest the cited range, by distance, then line, then name. */
function nearestSymbol(symbols: readonly ExportedSymbol[], ref: CodeRef): ExportedSymbol {
  let best = symbols[0] as ExportedSymbol;
  let bestDistance = distanceTo(ref, best.line);
  for (const symbol of symbols) {
    const distance = distanceTo(ref, symbol.line);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        (symbol.line < best.line || (symbol.line === best.line && byCodePoint(symbol.name, best.name) < 0)))
    ) {
      best = symbol;
      bestDistance = distance;
    }
  }
  return best;
}

/** The page names a symbol the file no longer exports. */
function missingClaim(ref: CodeRef, name: string): Diagnostic {
  return {
    id: "drift.missing-symbol",
    severity: "warning",
    message: `"${ref.path}" does not export "${name}", which this page claims at line ${ref.line}.`,
    pos: ref.pos,
    help: "Update the reference to the symbol's new name, or remove it.",
  };
}

/** The page names a symbol that exists, but its declaration moved outside the tolerance. */
function movedClaim(ref: CodeRef, name: string, line: number, tolerance: number): Diagnostic {
  return {
    id: "drift.moved-symbol",
    severity: "warning",
    message: `"${ref.path}" declares "${name}" at line ${line}; the cited line is ${ref.line}, outside the ${tolerance}-line tolerance.`,
    pos: ref.pos,
    help: `Point the reference at line ${line}, or update the page to match the code.`,
  };
}

/** No symbol is named, but the cited line no longer lands near a declaration. */
function movedWithoutClaim(ref: CodeRef, symbol: ExportedSymbol, tolerance: number): Diagnostic {
  return {
    id: "drift.moved-symbol",
    severity: "warning",
    message: `"${ref.path}" has no exported declaration close to line ${ref.line} (tolerance ${tolerance}); the nearest is "${symbol.name}" at line ${symbol.line}.`,
    pos: ref.pos,
    help: `Point the reference at line ${symbol.line}, or update the page to match the code.`,
  };
}

/** A cited TypeScript file exports nothing to point at. */
function noSymbols(ref: CodeRef): Diagnostic {
  return {
    id: "drift.missing-symbol",
    severity: "warning",
    message: `"${ref.path}" exports no symbols, so the cited line ${ref.line} has nothing to point at.`,
    pos: ref.pos,
    help: "Cite a file that exports the symbol, or remove the reference.",
  };
}

/** Orders diagnostics by line, then column, then ID, then message. */
function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const line = (a.pos?.line ?? 0) - (b.pos?.line ?? 0);
  if (line !== 0) return line;
  const column = (a.pos?.column ?? 0) - (b.pos?.column ?? 0);
  if (column !== 0) return column;
  const id = byCodePoint(a.id, b.id);
  if (id !== 0) return id;
  return byCodePoint(a.message, b.message);
}
