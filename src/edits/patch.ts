/**
 * Span-based patching of a Markdown source file.
 *
 * A patch names one span with the units of ADR 0026 and ADR 0027: 1-based lines and columns,
 * columns count Unicode code points (an astral character is one column, even though it is two
 * UTF-16 code units), and the end is inclusive. Applying a patch replaces exactly that span and
 * leaves every other byte alone, line endings included.
 *
 * The patch can carry the text it expects to find and the SHA-256 of the file it was computed
 * from. Both are optional; a caller that wants them enforced passes `requireExpected` or
 * `requireHash` in the options (the `mizzen fix` command is the strict caller).
 */
import { createHash } from "node:crypto";

/** One span of one source file. `file` is informational: patching text never reads the file. */
export interface PatchSpan {
  /** Path of the source file, relative to the repository root. */
  readonly file?: string;
  /** Line where the replaced text starts. */
  readonly line: number;
  /** Column where the replaced text starts (inclusive, 1-based, Unicode code points). */
  readonly column: number;
  /** Line where the replaced text ends. */
  readonly endLine: number;
  /** Column of the span's last character (inclusive, 1-based, Unicode code points). */
  readonly endColumn: number;
}

/** A replacement on one span of a source file. */
export interface Patch {
  /** The characters to replace. The end is inclusive; the span is non-empty. */
  readonly span: PatchSpan;
  /** The text the span held when the patch was computed. Used to refuse a stale patch. */
  readonly expected?: string;
  /** The text that takes the span's place. The empty string deletes it. */
  readonly replacement: string;
  /** SHA-256 of the whole source, hex, when the patch was computed. */
  readonly beforeHash?: string;
}

/** Options for {@link applyPatch}. Everything defaults to off: a patch is checked only for what it carries. */
export interface ApplyPatchOptions {
  /** Refuse a patch with no `expected` instead of applying it unchecked. */
  readonly requireExpected?: boolean;
  /** Refuse a patch with no `beforeHash` instead of applying it unchecked. */
  readonly requireHash?: boolean;
}

/** Why a patch was refused. Each code names one check, so a caller can tell them apart. */
export type PatchErrorCode =
  | "expected-mismatch"
  | "hash-mismatch"
  | "missing-expected"
  | "missing-hash"
  | "out-of-range";

/** A refused patch. `span` is the patch's span as given, so the caller can report where it pointed. */
export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly span: PatchSpan;
  /** The text the patch expected, when it carried one. */
  readonly expected: string | undefined;
  /** The text the source actually held, when the error came from comparing it. */
  readonly actual: string | undefined;

  constructor(
    code: PatchErrorCode,
    message: string,
    span: PatchSpan,
    detail: { readonly expected?: string; readonly actual?: string } = {},
  ) {
    super(message);
    this.name = "PatchError";
    this.code = code;
    this.span = span;
    this.expected = detail.expected;
    this.actual = detail.actual;
  }
}

/** The UTF-16 offsets of a span; slicing `source` with them returns exactly the span's text. */
export interface SpanOffsets {
  readonly start: number;
  readonly end: number;
}

/** SHA-256 of the whole source, hex. The hash a patch's `beforeHash` carries. */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** A span as people read it: `file:line:column-endLine:endColumn`, without the file when it has none. */
export function formatPatchSpan(span: PatchSpan): string {
  const where = `${span.line}:${span.column}-${span.endLine}:${span.endColumn}`;
  return span.file === undefined ? where : `${span.file}:${where}`;
}

/** The start of every line in `source`; `source.split("\n")` gives the matching line texts. */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** A whole-number line or column, 1-based. */
function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * The UTF-16 offset of code point `index` in `line` (0-based), where `index` may equal the number
 * of code points to name the position after the last character. Surrogate pairs count once.
 */
function codePointOffset(line: string, index: number): number {
  let offset = 0;
  let seen = 0;
  for (const character of line) {
    if (seen === index) break;
    offset += character.length;
    seen += 1;
  }
  return offset;
}

function outOfRange(source: string, span: PatchSpan, reason: string): PatchError {
  const lines = source.split("\n");
  return new PatchError(
    "out-of-range",
    `Span ${formatPatchSpan(span)} is outside the source (${lines.length} line${lines.length === 1 ? "" : "s"}): ${reason}`,
    span,
  );
}

/**
 * Converts a span to UTF-16 offsets. The end is inclusive, so the returned `end` is the offset just
 * after the span's last character. Lines keep a trailing `\r`, as `sliceSpan` does, so a CRLF file
 * measures columns exactly as its bytes are laid out.
 *
 * Throws a {@link PatchError} with code `out-of-range` when the span runs outside the source.
 */
export function spanToOffsets(source: string, span: PatchSpan): SpanOffsets {
  if (!positiveInteger(span.line) || !positiveInteger(span.column)) {
    throw outOfRange(source, span, "lines and columns are 1-based positive integers");
  }
  if (!positiveInteger(span.endLine) || !positiveInteger(span.endColumn)) {
    throw outOfRange(source, span, "end lines and end columns are 1-based positive integers");
  }

  const lines = source.split("\n");
  const starts = lineStartsOf(source);
  const startLine = lines[span.line - 1];
  const endLine = lines[span.endLine - 1];
  if (startLine === undefined) throw outOfRange(source, span, `there is no line ${span.line}`);
  if (endLine === undefined) throw outOfRange(source, span, `there is no line ${span.endLine}`);
  if (span.endLine < span.line || (span.endLine === span.line && span.endColumn < span.column)) {
    throw outOfRange(source, span, "the end runs before the start");
  }

  // The start may sit just after the last character; the inclusive end must name a real character.
  const startCodePoints = Array.from(startLine).length;
  const endCodePoints = Array.from(endLine).length;
  if (span.column > startCodePoints + 1) {
    throw outOfRange(source, span, `line ${span.line} has ${startCodePoints} columns`);
  }
  if (span.endColumn > endCodePoints) {
    throw outOfRange(source, span, `line ${span.endLine} has ${endCodePoints} columns`);
  }

  const start = (starts[span.line - 1] ?? 0) + codePointOffset(startLine, span.column - 1);
  const end = (starts[span.endLine - 1] ?? 0) + codePointOffset(endLine, span.endColumn);
  if (end < start) throw outOfRange(source, span, "the end runs before the start");
  return { start, end };
}

/** The source text a span names. Throws a {@link PatchError} with code `out-of-range` when it cannot. */
export function sliceBySpan(source: string, span: PatchSpan): string {
  const { start, end } = spanToOffsets(source, span);
  return source.slice(start, end);
}

/** A quoted snippet for an error message, kept short so a whole block does not land in a log. */
function snippet(text: string, limit = 80): string {
  const quoted = JSON.stringify(text);
  if (quoted.length <= limit) return quoted;
  return `${quoted.slice(0, limit)}… (${Array.from(text).length} code points)`;
}

/**
 * Applies one patch: replaces exactly the span's characters with `replacement` and returns the
 * result. The source is never mutated, and every character outside the span, including CRLF line
 * endings and a trailing newline, is copied through unchanged.
 *
 * Before touching anything it checks, in order:
 * 1. `beforeHash`, when present (or required), against the SHA-256 of `source`;
 * 2. the span's bounds, against the source;
 * 3. `expected`, when present (or required), against the text at the span.
 *
 * Every refusal throws a {@link PatchError}; a refusal never returns a partly patched string.
 */
export function applyPatch(source: string, patch: Patch, options: ApplyPatchOptions = {}): string {
  const { span } = patch;

  if (patch.beforeHash === undefined) {
    if (options.requireHash === true) {
      throw new PatchError(
        "missing-hash",
        `Patch at ${formatPatchSpan(span)} has no beforeHash; a stale source cannot be ruled out`,
        span,
      );
    }
  } else {
    const actualHash = hashSource(source);
    if (patch.beforeHash.toLowerCase() !== actualHash) {
      throw new PatchError(
        "hash-mismatch",
        `Patch at ${formatPatchSpan(span)} was computed for ${patch.beforeHash}, but the source hashes to ${actualHash}`,
        span,
        { actual: actualHash },
      );
    }
  }

  const { start, end } = spanToOffsets(source, span);

  if (patch.expected === undefined) {
    if (options.requireExpected === true) {
      throw new PatchError(
        "missing-expected",
        `Patch at ${formatPatchSpan(span)} has no expected text; the span's content cannot be checked`,
        span,
      );
    }
  } else {
    const actual = source.slice(start, end);
    if (actual !== patch.expected) {
      throw new PatchError(
        "expected-mismatch",
        `Patch at ${formatPatchSpan(span)} expected ${snippet(patch.expected)}, but found ${snippet(actual)}`,
        span,
        { expected: patch.expected, actual },
      );
    }
  }

  return source.slice(0, start) + patch.replacement + source.slice(end);
}
