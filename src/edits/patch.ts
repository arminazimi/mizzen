/**
 * Span-based patching of a Markdown source file.
 *
 * A patch names one span with the units of the source spans: 1-based lines and columns,
 * columns count Unicode code points (an astral character is one column, even though it is two
 * UTF-16 code units), and the end is inclusive. Applying a patch replaces exactly that span and
 * leaves every other byte alone, line endings included.
 *
 * The patch can carry the text it expects to find and the SHA-256 of the file it was computed
 * from. Both are optional; a caller that wants them enforced passes `requireExpected` or
 * `requireHash` in the options (the `mizzen fix` command is the strict caller).
 *
 * A whole edit is checked before it produces anything. {@link applyPatches} refuses two edits of
 * the same or overlapping text and returns no text when any patch is refused;
 * {@link applyFilePatches} does the same across files, and {@link writeFilePatches} is the only
 * function here that touches the filesystem: it reads every file, validates the whole set, stages
 * every result, and only then renames the files in. A refused set therefore leaves the tree as it
 * was found.
 *
 * Writes are confined to the site root by real path, not by spelling (#98): a target whose parent
 * resolves outside the root, and a target that is itself an existing symlink, are refused before any
 * file is read, and the boundary is checked again when the staged files are committed, so a parent
 * swapped for an escaping symlink in the meantime cannot redirect the rename.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  | "out-of-range"
  | "ambiguous-span"
  | "overlapping-spans";

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

/** Why a whole edit set was refused before any file was written. */
export type EditFileErrorCode =
  | "duplicate-file"
  | "file-mismatch"
  | "path-escape"
  | "source-missing"
  | "stale-source"
  | "write-failed";

/** A refused edit set. `file` names the file the refusal is about. */
export class EditFileError extends Error {
  readonly code: EditFileErrorCode;
  readonly file: string;

  constructor(code: EditFileErrorCode, file: string, message: string) {
    super(message);
    this.name = "EditFileError";
    this.code = code;
    this.file = file;
  }
}

/** The UTF-16 offsets of a span; slicing `source` with them returns exactly the span's text. */
export interface SpanOffsets {
  readonly start: number;
  readonly end: number;
}

/** The text after a set of patches, and the spans its replacements occupy. */
export interface PatchedText {
  /** The source with every patch applied. */
  readonly text: string;
  /** The replacements' spans in `text`, in source order. A deletion leaves no span. */
  readonly spans: readonly PatchSpan[];
}

/** One file's text and the patches to apply to it. */
export interface FilePatches {
  /** The file's path, relative to the repository root. */
  readonly file: string;
  /** The file's text as read just before applying, including line endings. */
  readonly source: string;
  /** The patches for this file. They may not share or overlap a span. */
  readonly patches: readonly Patch[];
}

/** One file's content after every patch in an edit set passed. */
export interface PatchedFile {
  /** The file's path, as given. */
  readonly file: string;
  /** The file's text before the edit. */
  readonly before: string;
  /** SHA-256 of `before`. */
  readonly beforeHash: string;
  /** The file's text after the edit. */
  readonly after: string;
  /** SHA-256 of `after`. */
  readonly afterHash: string;
  /** The replacements' spans in `after`, in source order. A deletion leaves no span. */
  readonly spans: readonly PatchSpan[];
}

/** One file to edit on disk: its path relative to the site root, and its patches. */
export interface EditFile {
  readonly file: string;
  readonly patches: readonly Patch[];
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
 * Checks one patch against `source`, in order: hash, span, expected text. Returns the span's
 * offsets only when every carried precondition holds.
 */
function checkPatch(source: string, patch: Patch, options: ApplyPatchOptions): SpanOffsets {
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

  const offsets = spanToOffsets(source, span);

  if (patch.expected === undefined) {
    if (options.requireExpected === true) {
      throw new PatchError(
        "missing-expected",
        `Patch at ${formatPatchSpan(span)} has no expected text; the span's content cannot be checked`,
        span,
      );
    }
  } else {
    const actual = source.slice(offsets.start, offsets.end);
    if (actual !== patch.expected) {
      throw new PatchError(
        "expected-mismatch",
        `Patch at ${formatPatchSpan(span)} expected ${snippet(patch.expected)}, but found ${snippet(actual)}`,
        span,
        { expected: patch.expected, actual },
      );
    }
  }

  return offsets;
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
  const { start, end } = checkPatch(source, patch, options);
  return source.slice(0, start) + patch.replacement + source.slice(end);
}

/** The line and column of a UTF-16 offset, and of the character before the end offset. */
function spanOfOffsets(source: string, start: number, end: number): PatchSpan | undefined {
  // A span cannot name a line feed as its last character; a replacement that ends with one has no
  // representable resulting span.
  if (end <= start || source[end - 1] === "\n") return undefined;
  const beforeStart = source.slice(0, start);
  const beforeEnd = source.slice(0, end);
  const line = 1 + (beforeStart.match(/\n/g)?.length ?? 0);
  const endLine = 1 + (beforeEnd.match(/\n/g)?.length ?? 0);
  const column = Array.from(beforeStart.slice(beforeStart.lastIndexOf("\n") + 1)).length + 1;
  const endColumn = Array.from(beforeEnd.slice(beforeEnd.lastIndexOf("\n") + 1)).length;
  return { line, column, endLine, endColumn };
}

/**
 * Applies every patch to `source` as one change. All patches are checked before any text is
 * produced, so a stale hash, out-of-range span, or missing expected text leaves the source
 * untouched. Two patches that share a span are `ambiguous-span`; two that overlap (but are not
 * identical) are `overlapping-spans`. Adjacent spans are fine.
 *
 * The returned `spans` are the replacements' positions in the new text, for a proof record.
 */
export function applyPatches(
  source: string,
  patches: readonly Patch[],
  options: ApplyPatchOptions = {},
): PatchedText {
  const checked = patches.map((patch) => ({ patch, offsets: checkPatch(source, patch, options) }));
  checked.sort((a, b) => a.offsets.start - b.offsets.start || a.offsets.end - b.offsets.end);

  for (let index = 1; index < checked.length; index += 1) {
    const previous = checked[index - 1]!;
    const current = checked[index]!;
    if (current.offsets.start >= previous.offsets.end) continue;
    const identical =
      current.offsets.start === previous.offsets.start && current.offsets.end === previous.offsets.end;
    throw new PatchError(
      identical ? "ambiguous-span" : "overlapping-spans",
      identical
        ? `Spans ${formatPatchSpan(previous.patch.span)} and ${formatPatchSpan(current.patch.span)} name the same text; the replacement is ambiguous`
        : `Spans ${formatPatchSpan(previous.patch.span)} and ${formatPatchSpan(current.patch.span)} overlap`,
      current.patch.span,
    );
  }

  let text = "";
  let cursor = 0;
  const spans: PatchSpan[] = [];
  for (const { patch, offsets } of checked) {
    text += source.slice(cursor, offsets.start);
    const start = text.length;
    text += patch.replacement;
    const span = spanOfOffsets(text, start, text.length);
    if (span !== undefined) spans.push(span);
    cursor = offsets.end;
  }
  text += source.slice(cursor);
  return { text, spans };
}

/**
 * Applies every file's patches, refusing the whole set when any file is refused. No result is
 * returned for a partial edit, so a caller that writes only after this returns cannot write half
 * an edit set.
 *
 * A file listed twice is `duplicate-file`; a patch whose `span.file` names another file is
 * `file-mismatch`.
 */
export function applyFilePatches(
  files: readonly FilePatches[],
  options: ApplyPatchOptions = {},
): readonly PatchedFile[] {
  const seen = new Set<string>();
  const results: PatchedFile[] = [];
  for (const { file, source, patches } of files) {
    if (seen.has(file)) {
      throw new EditFileError("duplicate-file", file, `${file}: the edit set lists this file more than once.`);
    }
    seen.add(file);
    for (const patch of patches) {
      if (patch.span.file !== undefined && patch.span.file !== file) {
        throw new EditFileError(
          "file-mismatch",
          file,
          `${file}: a patch names ${formatPatchSpan(patch.span)}, which is not this file.`,
        );
      }
    }

    const patched = applyPatches(source, patches, options);
    results.push({
      file,
      before: source,
      beforeHash: hashSource(source),
      after: patched.text,
      afterHash: hashSource(patched.text),
      spans: patched.spans,
    });
  }
  return results;
}

/** The target inside the site root, refusing a path that is not a relative path inside it. */
function insideRoot(root: string, file: string): { readonly path: string; readonly record: string } {
  if (file === "" || isAbsolute(file) || file.includes("\\") || /^[a-zA-Z]:/.test(file)) {
    throw new EditFileError(
      "path-escape",
      file,
      `${file}: the edit names a path that is not relative to the site root; use a relative path with forward slashes.`,
    );
  }
  const path = resolve(root, file);
  const inside = relative(root, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new EditFileError("path-escape", file, `${file}: the path is outside the site root "${root}"; refusing it.`);
  }
  return { path, record: inside.split(sep).join("/") };
}

/** Whether `path` is `root` itself or sits below it. Both are real, resolved paths. */
function withinReal(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/**
 * The real site root. A root that cannot be resolved is passed back as given, so the read of a
 * missing source reports it as `source-missing` the way it always has.
 */
async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/**
 * The path a verified write may use: the target with every parent symlink resolved, refused when the
 * resolved parent leaves the real site root or when the target is itself an existing symlink.
 *
 * A symlinked parent is the case a lexical check misses: `readFile` follows it, `mkdtemp` stages
 * beside it, and `rename` writes through it, so an in-root spelling can still change a file outside
 * the root. A target that is a link is refused rather than resolved, because the two operations the
 * edit needs disagree about it: reading follows the link to another file, renaming replaces the link
 * itself. A path that cannot be resolved at all is returned as given; reading it reports why.
 */
async function verifiedTarget(realRoot: string, file: string, path: string): Promise<string> {
  const parent = dirname(path);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch {
    return path;
  }
  if (!withinReal(realRoot, realParent)) {
    throw new EditFileError(
      "path-escape",
      file,
      `${file}: the path resolves outside the site root "${realRoot}"; refusing it.`,
    );
  }

  const resolved = realParent === parent ? path : join(realParent, basename(path));
  try {
    if ((await lstat(resolved)).isSymbolicLink()) {
      throw new EditFileError(
        "path-escape",
        file,
        `${file}: the target is a symbolic link, so the edit would read one file and write another; refusing it.`,
      );
    }
  } catch (error) {
    if (error instanceof EditFileError) throw error;
    // An unreadable target is reported by the read that follows it.
  }
  return resolved;
}

/**
 * Test seams, as the transaction writer's `TransactionHooks` are for it. Production callers pass
 * nothing; the hook runs at the named point and a thrown error is handled exactly as the equivalent
 * filesystem failure would be.
 */
export interface PatchWriteHooks {
  /** After every file is staged, before the commit checks run. A test can swap a parent here. */
  readonly beforeCommit?: () => void | Promise<void>;
}

/** One staged file: its new bytes are written beside the target, ready for one rename. */
interface StagedFile {
  /** The path the caller named, resolved against the site root; the boundary check re-runs on it. */
  readonly lexical: string;
  /** The verified real path the file is written to. Refreshed at commit time. */
  target: string;
  readonly file: string;
  readonly original: string;
  readonly beforeHash: string;
  readonly mode: number;
  readonly staging: string;
  readonly temp: string;
}

/**
 * Stages `after` beside the verified `target`, so the write is one rename. Cleans up if staging
 * fails. `lexical` is kept so the commit can repeat the boundary check on the path the caller named.
 */
async function stageFile(
  lexical: string,
  target: string,
  file: string,
  after: string,
  original: string,
  beforeHash: string,
): Promise<StagedFile> {
  const staging = await mkdtemp(join(dirname(target), ".edit-patch-"));
  try {
    const mode = (await stat(target)).mode & 0o7777;
    const temp = join(staging, "source");
    await writeFile(temp, after, "utf8");
    await chmod(temp, mode);
    return { lexical, target, file, original, beforeHash, mode, staging, temp };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Puts `text` back in one rename, used to roll back a commit that failed partway. */
async function restoreFile(target: string, text: string, mode: number): Promise<void> {
  const staging = await mkdtemp(join(dirname(target), ".edit-restore-"));
  try {
    const temp = join(staging, "source");
    await writeFile(temp, text, "utf8");
    await chmod(temp, mode);
    await rename(temp, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The reason an errno error gives, as one phrase. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "it does not exist";
  if (code === "EISDIR") return "it is a directory";
  if (code === "EACCES" || code === "EPERM") return "it is not readable";
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies an edit set to the tree under `siteRoot` as one transaction.
 *
 * Every file is read and checked first, so a stale hash, an overlapping or out-of-range span, or a
 * missing expected text refuses the whole set before anything is written. The new bytes are then
 * staged beside each file and renamed in; if a rename fails the files already replaced are put
 * back from the bytes read at the start. The returned entries carry the before and after SHA-256
 * and the resulting spans, ready for {@link createProof}.
 *
 * A `file` that is absolute or leaves `siteRoot` is `path-escape`, and so is one whose parents
 * resolve outside it or whose target is an existing symlink (#98); a file that cannot be read is
 * `source-missing`. Both preconditions are required by default: pass `requireHash: false` or
 * `requireExpected: false` to disable that one; the other stays required.
 */
export async function writeFilePatches(
  siteRoot: string,
  files: readonly EditFile[],
  options: ApplyPatchOptions = {},
  hooks: PatchWriteHooks = {},
): Promise<readonly PatchedFile[]> {
  const root = resolve(siteRoot);
  const realRoot = await realRootOf(root);
  const targets: {
    readonly lexical: string;
    readonly path: string;
    readonly record: string;
    readonly patches: readonly Patch[];
  }[] = [];
  const records = new Set<string>();
  for (const entry of files) {
    const target = insideRoot(root, entry.file);
    if (records.has(target.record)) {
      throw new EditFileError(
        "duplicate-file",
        target.record,
        `${target.record}: the edit set lists this file more than once.`,
      );
    }
    records.add(target.record);
    // The real path is settled before anything is read, so no step of the edit — reading, staging or
    // renaming — follows a path that leaves the root.
    const path = await verifiedTarget(realRoot, target.record, target.path);
    targets.push({ lexical: target.path, path, record: target.record, patches: entry.patches });
  }

  const inputs: FilePatches[] = [];
  for (const target of targets) {
    let source: string;
    try {
      source = await readFile(target.path, "utf8");
    } catch (error) {
      throw new EditFileError(
        "source-missing",
        target.record,
        `${target.record}: cannot read the file to edit: ${reasonOf(error)}; nothing was written.`,
      );
    }
    inputs.push({ file: target.record, source, patches: target.patches });
  }

  // Every check runs here; a refusal leaves no staging folder and no changed file.
  // Each default is explicit so disabling one option leaves the other required.
  const results = applyFilePatches(inputs, {
    requireHash: options.requireHash ?? true,
    requireExpected: options.requireExpected ?? true,
  });

  const staged: StagedFile[] = [];
  try {
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const target = targets[index]!;
      // Stage only beside a target that is still in the root at the moment the folder is created, so
      // a swap after the check above cannot put a staging folder, or the rename, outside it.
      const verified = await verifiedTarget(realRoot, target.record, target.lexical);
      staged.push(
        await stageFile(
          target.lexical,
          verified,
          result.file,
          result.after,
          result.before,
          result.beforeHash,
        ),
      );
    }
  } catch (error) {
    await Promise.allSettled(staged.map((item) => rm(item.staging, { recursive: true, force: true })));
    if (error instanceof EditFileError) throw error;

    const failed = results[staged.length];
    throw new EditFileError(
      "write-failed",
      failed?.file ?? "",
      `${failed?.file ?? "the edit"}: staging the edit failed: ${reasonOf(error)}; nothing was written.`,
    );
  }

  const committed: StagedFile[] = [];
  try {
    // The hook runs before the commit checks so a test can change a target between staging and
    // commit, exactly as the transaction writer's hook does.
    await hooks.beforeCommit?.();

    // Repeat the boundary check now that the bytes are staged: a parent swapped for an escaping
    // symlink while the edit was staged is refused here rather than redirecting the rename below.
    // Each rename goes to the path that was just verified, not to the spelling the caller named.
    for (const item of staged) {
      item.target = await verifiedTarget(realRoot, item.file, item.lexical);
    }

    // Re-read immediately before writing: a file that changed since it was validated refuses the
    // whole set, so an exact span is never written onto text the plan did not see.
    for (const item of staged) {
      let current: string;
      try {
        current = await readFile(item.target, "utf8");
      } catch (error) {
        throw new EditFileError(
          "source-missing",
          item.file,
          `${item.file}: the file cannot be read before writing: ${reasonOf(error)}; nothing was written.`,
        );
      }
      if (hashSource(current) !== item.beforeHash) {
        throw new EditFileError(
          "stale-source",
          item.file,
          `${item.file}: the file changed while the edit was staged; nothing was written.`,
        );
      }
    }

    for (const item of staged) {
      await rename(item.temp, item.target);
      committed.push(item);
    }
  } catch (error) {
    if (error instanceof EditFileError) throw error;

    const failed = staged[committed.length];
    let rollback = committed.length === 0 ? "nothing was replaced" : "the files already replaced were restored";
    for (const item of [...committed].reverse()) {
      try {
        await restoreFile(item.target, item.original, item.mode);
      } catch {
        rollback = `restoring ${item.file} also failed; check the tree`;
      }
    }
    throw new EditFileError(
      "write-failed",
      failed?.file ?? results[0]?.file ?? "",
      `${failed?.file ?? "the edit"}: writing the file failed: ${reasonOf(error)}; ${rollback}.`,
    );
  } finally {
    await Promise.allSettled(staged.map((item) => rm(item.staging, { recursive: true, force: true })));
  }

  return results;
}
