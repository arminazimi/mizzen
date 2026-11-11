import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import { parseFrontMatter } from "./frontmatter.ts";

/**
 * Expands `::include` directives before the Markdown stage, because a Markdown plugin has no site root and no page
 * path: only the content stage knows where the page and the source folder are.
 *
 * A directive is a whole line, either a label form or an attribute form:
 *
 *   `::include[snippets/warning.md]` and `::include[snippets/warning.md]{lines=2-10}`
 *   `::include{path="snippets/warning.md" lines="2-10"}`
 *
 * The path is relative to the file that holds the directive and may never leave the source folder. The file's front
 * matter is stripped, `lines` keeps a 1-based inclusive range of what remains, and the text is spliced in place.
 * Includes inside an included file are expanded too, with that file's folder as the base, up to `maxDepth`.
 * A line inside a fenced code block is text, never a directive.
 *
 * Source positions: the body keeps its starting line, and every text line that is not an include keeps its own line
 * only until the first include expands, because a snippet adds or removes lines. Diagnostics name the file that
 * holds the directive and its line there — an included file for a nested include, the page for a top-level one —
 * while `data-src` on rendered blocks still counts lines in the page. That is as far as a splice can map without
 * changing the contract's one-file `SourcePos`.
 */

/** What {@link expandIncludes} needs to expand one body. */
export interface ExpandIncludesOptions {
  /** The body after front matter, as {@link parseFrontMatter} returns it. */
  readonly body: string;
  /** 1-based line of the file where `body` starts. */
  readonly bodyLine: number;
  /** Path of the file that holds `body`, relative to `sourceDir`, `/`-separated. */
  readonly file: string;
  /** Absolute path of the site's source folder; no include may resolve outside it. */
  readonly sourceDir: string;
  /** Path used in diagnostics when it differs from `file`, usually repository-relative. Defaults to `file`. */
  readonly displayFile?: string;
  /** How many includes may nest, counting the first include as depth 1. Defaults to 10. */
  readonly maxDepth?: number;
}

/** One file a body depends on: the target of an `::include` directive, at every nesting level. */
export interface IncludeDependency {
  /** Path of the file that holds the directive, relative to `sourceDir`, `/`-separated. */
  readonly from: string;
  /** Path the directive names, relative to `sourceDir`, `/`-separated. */
  readonly path: string;
  /** The span of the directive line. */
  readonly pos: SourcePos;
  /** True when the named file does not exist under the source folder. */
  readonly missing: boolean;
}

/** What {@link expandIncludes} returns. */
export interface IncludeResult {
  /** The body with every expandable directive replaced by its file. */
  readonly body: string;
  /** The starting line of the body, the same as the input's: the lines before it did not move. */
  readonly bodyLine: number;
  /** One finding per directive that could not be expanded; empty when every directive worked. */
  readonly diagnostics: readonly Diagnostic[];
  /** Every directive's target, in the order the directives were read; a cycle's closing edge is included. */
  readonly includes: readonly IncludeDependency[];
}

/** The directive alone on a line, with an optional label and optional attributes. */
const DIRECTIVE = /^ {0,3}::include(?:\[([^\]\n]*)\])?[ \t]*(?:\{([^}\n]*)\})?[ \t]*$/;

/** `key=value`, `key="value"`, or `key='value'` inside the braces. */
const ATTRIBUTE = /([A-Za-z][\w:.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;

/** A fence that opens a code block; a directive inside one is an example, not an include. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The default nesting limit. */
const DEFAULT_MAX_DEPTH = 10;

/** A file already being expanded, so a cycle names the whole chain. */
interface Frame {
  /** Absolute path, the key a cycle is found by. */
  readonly key: string;
  /** Path shown in messages. */
  readonly display: string;
}

/** What every level of the expansion shares. */
interface Scope {
  readonly sourceDir: string;
  readonly maxDepth: number;
  /** Prefix that turns a source-relative path into the display path; `""` when the two are the same. */
  readonly prefix: string;
  readonly diagnostics: Diagnostic[];
  readonly includes: IncludeDependency[];
}

/** A 1-based inclusive range of lines. */
interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The line without its terminator. */
const strip = (line: string): string => line.replace(/\r?\n$/, "");

/** A finding that fails the build, with the directive's position. */
function problem(id: string, message: string, pos: SourcePos, help?: string): Diagnostic {
  return { id, severity: "error", message, pos, ...(help === undefined ? {} : { help }) };
}

/** The span of one directive line: its whole line, starting at column 1. */
function posOf(file: string, line: number, length: number): SourcePos {
  const endColumn = Math.max(1, length);
  return { file, line, column: 1, endLine: line, endColumn };
}

/** The brace attributes of a directive, last key winning like the Markdown plugin's attributes. */
function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const key = match[1];
    if (key === undefined) continue;
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

/** `2-10` or `4` as a line range; `undefined` when it is not one. */
function parseLines(text: string): LineRange | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return undefined;
  // A range that large would never fit a file; refuse early rather than overflow a number.
  if (end > Number.MAX_SAFE_INTEGER) return undefined;
  return { start, end };
}

/** Which lines of `lines` sit inside a fenced code block; the fences themselves do not. */
function fencedLines(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let open: { readonly char: string; readonly length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = strip(lines[i]!);
    if (open === undefined) {
      const match = FENCE.exec(text);
      if (match) {
        const run = match[1]!;
        open = { char: run[0]!, length: run.length };
      }
      continue;
    }
    inside[i] = true;
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
    if (close) {
      const run = close[1]!;
      if (run[0] === open.char && run.length >= open.length) {
        inside[i] = false;
        open = undefined;
      }
    }
  }
  return inside;
}

/** The display prefix when `displayFile` ends with `file` on a path boundary. */
function prefixOf(displayFile: string, file: string): string {
  if (!displayFile.endsWith(file)) return "";
  const prefix = displayFile.slice(0, displayFile.length - file.length);
  return prefix === "" || prefix.endsWith("/") ? prefix : "";
}

/** The path shown for a source-relative `path`. */
function displayOf(scope: Scope, path: string): string {
  return scope.prefix + path;
}

/** The absolute path a cycle is keyed by, `/`-separated so the key is stable. */
function keyOf(sourceDir: string, path: string): string {
  return resolve(sourceDir, path).split(sep).join("/");
}

/** The text of an included file after its front matter, sliced to `range` when one is asked for. */
function contentOf(
  scope: Scope,
  text: string,
  display: string,
  range: LineRange | undefined,
  pos: SourcePos,
): { readonly text: string; readonly line: number } | undefined {
  const stripped = parseFrontMatter(text, display);
  if (range === undefined) return { text: stripped.body, line: stripped.bodyLine };
  const lines = stripped.body.split(/(?<=\n)/);
  if (range.start > lines.length || range.end > lines.length) {
    scope.diagnostics.push(
      problem(
        "include.lines-out-of-range",
        `\`lines=${range.start}-${range.end}\` is outside ${display}, which has ${lines.length} line${lines.length === 1 ? "" : "s"} after its front matter.`,
        pos,
        "Name a range that fits the file, counting the first content line as 1.",
      ),
    );
    return undefined;
  }
  return { text: lines.slice(range.start - 1, range.end).join(""), line: stripped.bodyLine + range.start - 1 };
}

/** Expands one directive line, returning the text that replaces it, or `undefined` to drop the line. */
async function expandDirective(
  scope: Scope,
  input: {
    readonly relPath: string;
    readonly displayPath: string;
    readonly lineNo: number;
    readonly lineText: string;
    readonly label: string | undefined;
    readonly attrs: string | undefined;
  },
  stack: readonly Frame[],
): Promise<string | undefined> {
  const pos = posOf(input.displayPath, input.lineNo, input.lineText.length);
  const attributes = attributesOf(input.attrs ?? "");
  const path = (input.label ?? "").trim() !== "" ? input.label!.trim() : (attributes.path ?? "").trim();
  if (path === "") {
    scope.diagnostics.push(
      problem(
        "include.no-path",
        "An include names no file.",
        pos,
        'Write `::include[snippets/example.md]` or `::include{path="snippets/example.md"}`.',
      ),
    );
    return undefined;
  }

  const rangeText = attributes.lines;
  let range: LineRange | undefined;
  if (rangeText !== undefined) {
    range = parseLines(rangeText);
    if (range === undefined) {
      scope.diagnostics.push(
        problem(
          "include.invalid-lines",
          `\`lines=${rangeText}\` is not a line range.`,
          pos,
          "Write `lines=2-10` for the 1-based inclusive range, or `lines=4` for one line.",
        ),
      );
      return undefined;
    }
  }

  const base = dirname(resolve(scope.sourceDir, input.relPath));
  const absolute = resolve(base, path);
  const inside = relative(scope.sourceDir, absolute);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    scope.diagnostics.push(
      problem(
        "include.outside-source",
        `The include ${path} is outside the source folder.`,
        pos,
        "An include may only read files under the source folder; move the file there or change the path.",
      ),
    );
    return undefined;
  }

  const rel = inside.split(sep).join("/");
  const display = displayOf(scope, rel);
  const key = keyOf(scope.sourceDir, rel);
  scope.includes.push({ from: input.relPath, path: rel, pos, missing: !existsSync(absolute) });
  if (stack.some((frame) => frame.key === key)) {
    const chain = [...stack.map((frame) => frame.display), display].join(" → ");
    scope.diagnostics.push(
      problem("include.cycle", `Include cycle: ${chain}.`, pos, "Remove the include that leads back to a file already being included."),
    );
    return undefined;
  }
  if (stack.length > scope.maxDepth) {
    scope.diagnostics.push(
      problem(
        "include.too-deep",
        `Includes nest more than ${scope.maxDepth} deep at ${display}.`,
        pos,
        "Flatten the snippets, or raise `maxDepth` where the build calls `expandIncludes`.",
      ),
    );
    return undefined;
  }

  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      scope.diagnostics.push(
        problem(
          "include.missing",
          `The include ${path} does not exist (looked for ${display}).`,
          pos,
          "Create the file, or fix the path relative to this file.",
        ),
      );
    } else {
      scope.diagnostics.push(
        problem(
          "include.unreadable",
          `The include ${path} cannot be read: ${(error as Error).message}`,
          pos,
          "Check the file's permissions and that it is a file, not a folder.",
        ),
      );
    }
    return undefined;
  }

  const content = contentOf(scope, text, display, range, pos);
  if (content === undefined) return undefined;
  const expanded = await expandBody(scope, content.text, content.line, rel, display, [...stack, { key, display }]);
  return expanded;
}

/** Expands every directive of one body; `stack` holds the files already being expanded, outermost first. */
async function expandBody(
  scope: Scope,
  body: string,
  bodyLine: number,
  relPath: string,
  displayPath: string,
  stack: readonly Frame[],
): Promise<string> {
  if (!body.includes("::include")) return body;
  const lines = body.split(/(?<=\n)/);
  const fenced = fencedLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = strip(line);
    const match = fenced[i] === true ? null : DIRECTIVE.exec(text);
    if (match === null) {
      out.push(line);
      continue;
    }
    const replacement = await expandDirective(
      scope,
      { relPath, displayPath, lineNo: bodyLine + i, lineText: text, label: match[1], attrs: match[2] },
      stack,
    );
    if (replacement === undefined || replacement === "") continue;
    // A snippet without a final newline must not merge with the line that follows the directive.
    out.push(line.endsWith("\n") && !replacement.endsWith("\n") ? `${replacement}\n` : replacement);
  }
  return out.join("");
}

/**
 * Expands the `::include` directives of one page body, reading only files under `sourceDir`. The body keeps its
 * starting line; every failure becomes a diagnostic at the directive's line and the rest of the body still expands.
 * `includes` reports every target with the file and line that named it, which a dependency graph reads.
 */
export async function expandIncludes(options: ExpandIncludesOptions): Promise<IncludeResult> {
  if (!options.body.includes("::include")) {
    return { body: options.body, bodyLine: options.bodyLine, diagnostics: [], includes: [] };
  }
  const file = options.file.split("\\").join("/");
  const displayFile = options.displayFile ?? file;
  const diagnostics: Diagnostic[] = [];
  const includes: IncludeDependency[] = [];
  const scope: Scope = {
    sourceDir: resolve(options.sourceDir),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    prefix: prefixOf(displayFile, file),
    diagnostics,
    includes,
  };
  const stack: Frame[] = [{ key: keyOf(scope.sourceDir, file), display: displayFile }];
  const body = await expandBody(scope, options.body, options.bodyLine, file, displayFile, stack);
  return { body, bodyLine: options.bodyLine, diagnostics, includes };
}
