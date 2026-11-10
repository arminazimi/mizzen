/**
 * A heading-aware diff of two Markdown documents.
 *
 * The document is split at its headings (ATX and Setext) and compared one section at a time,
 * so a section that moved shows up as moved instead of a delete plus an add. A section's
 * identity is its explicit `{#id}`, or else its heading text, together with the occurrence
 * number of that identity in the document; the occurrence is what keeps two `## Setup`
 * headings apart. Text before the first heading is a preamble and is not a section.
 *
 * Whitespace is normalised only for comparison: runs of whitespace collapse to one space, so
 * reflowing a paragraph or changing line endings is not a change. The text and ranges in the
 * result are the original bytes. Line ranges are 1-based and inclusive, and cover the heading
 * line through the last line before the next heading, including trailing blank lines.
 *
 * The comparison keeps the sections whose order agrees with both documents (a longest common
 * subsequence) where they are; a matched section outside that subsequence moved. This is a
 * deterministic transform of its two arguments: no disk, clock, network, or environment reads.
 */

/** A 1-based, inclusive range of lines in one document. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** What names a section in both documents: heading text, anchor id, and occurrence. */
export interface SectionIdentity {
  /** The heading as written, without a trailing `{#id}` and with surrounding whitespace trimmed. */
  readonly heading: string;
  /** The explicit `{#id}`, or the GitHub-compatible slug of `heading`. */
  readonly id: string;
  /** 1-based occurrence of this id or heading text among the document's headings. */
  readonly occurrence: number;
}

/** A section only the new document has. */
export interface AddedSection extends SectionIdentity {
  /** The new section exactly as written, heading line included. */
  readonly newText: string;
  readonly newRange: LineRange;
}

/** A section only the old document has. */
export interface RemovedSection extends SectionIdentity {
  /** The old section exactly as written, heading line included. */
  readonly oldText: string;
  readonly oldRange: LineRange;
}

/** A section present in both documents with a different body (ignoring whitespace). */
export interface ChangedSection extends SectionIdentity {
  readonly oldText: string;
  readonly oldRange: LineRange;
  readonly newText: string;
  readonly newRange: LineRange;
}

/**
 * A section present in both documents whose order changed. A moved section may also have a
 * different body; both versions are kept, so the move and the edit are visible together.
 */
export type MovedSection = ChangedSection;

/** The four kinds of section difference. Each list is in document order. */
export interface MarkdownDiff {
  /** New sections, in the new document's order. */
  readonly added: readonly AddedSection[];
  /** Old sections, in the old document's order. */
  readonly removed: readonly RemovedSection[];
  /** Sections that stayed in place with a different body, in the new document's order. */
  readonly changed: readonly ChangedSection[];
  /** Sections whose position changed, in the new document's order. */
  readonly moved: readonly MovedSection[];
}

/** One line of the source, with the offsets needed to slice its original spelling back out. */
interface SourceLine {
  /** The line without its terminator. */
  readonly text: string;
  /** UTF-16 offset of the line's first character. */
  readonly start: number;
  /** UTF-16 offset just past the line's last character, before its terminator. */
  readonly next: number;
}

/** A heading found by the scanner, before occurrence numbers are assigned. */
interface HeadingRecord {
  /** 0-based index of the heading's first line (the title line for a Setext heading). */
  readonly startIndex: number;
  readonly level: number;
  readonly heading: string;
  readonly explicitId: string | undefined;
}

/** A section of one document, with the key that pairs it across documents. */
interface ParsedSection extends SectionIdentity {
  readonly key: string;
  readonly text: string;
  readonly range: LineRange;
}

/** A pair of indexes into the old and new section arrays. */
interface LcsPair {
  readonly oldIndex: number;
  readonly newIndex: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const CUSTOM_ID = /\s*\{#([^\s{}]+)\}$/;

/** Splits at line terminators (LF, CRLF, or CR), keeping each line's original offsets. */
function linesOf(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 10) {
      lines.push({ text: source.slice(start, index), start, next: index + 1 });
      start = index + 1;
    } else if (code === 13) {
      const next = source.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
      lines.push({ text: source.slice(start, index), start, next });
      index = next - 1;
      start = next;
    }
  }
  if (start < source.length) {
    lines.push({ text: source.slice(start), start, next: source.length });
  }
  return lines;
}

/** Collapses every whitespace run to one space; the only normalisation the comparison uses. */
function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** A GitHub-compatible slug for a heading: lowercased, punctuation dropped, spaces hyphenated. */
function slugify(heading: string): string {
  return normalized(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** An ATX heading's level and visible text, with any closing hash run removed. */
function atxHeading(line: string): { readonly level: number; readonly text: string } | undefined {
  const match = ATX.exec(line);
  if (match === null) return undefined;
  const level = match[1]?.length ?? 0;
  return { level, text: (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/u, "") };
}

/** The level of a Setext underline, or undefined when the line is not one. */
function setextLevel(line: string): number | undefined {
  const match = SETEXT.exec(line);
  if (match === null) return undefined;
  return match[1]?.startsWith("=") === true ? 1 : 2;
}

/** Whether a line can be the title line above a Setext underline. */
function isSetextTitle(line: string): boolean {
  if (!/^ {0,3}\S/u.test(line)) return false; // Blank, or indented enough to be code.
  if (/^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|)/u.test(line)) return false; // List, quote, table.
  if (ATX.test(line) || SETEXT.test(line)) return false;
  return true;
}

/** A fence that opened and has not closed yet. */
interface Fence {
  readonly char: string;
  readonly length: number;
}

/** The fence a line opens, or undefined. An opening backtick fence's info string has no backtick. */
function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return undefined;
  const marker = match[1] ?? "";
  if (marker.startsWith("`") && (match[2] ?? "").includes("`")) return undefined;
  return { char: marker[0] ?? "`", length: marker.length };
}

/** Whether a line closes the current fence. Closing needs the same character and at least its length. */
function closesFence(line: string, fence: Fence): boolean {
  let rest = line.replace(/^ {0,3}/u, "");
  let count = 0;
  while (rest[count] === fence.char) count += 1;
  return count >= fence.length && rest.slice(count).trim() === "";
}

/** Every heading in the document, in document order, skipping fenced code. */
function headingsOf(lines: readonly SourceLine[]): HeadingRecord[] {
  const headings: HeadingRecord[] = [];
  const starts = new Set<number>();
  let fence: Fence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.text ?? "";
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opens = openingFence(line);
    if (opens !== undefined) {
      fence = opens;
      continue;
    }

    const atx = atxHeading(line);
    if (atx !== undefined) {
      const split = splitCustomId(atx.text);
      headings.push({ startIndex: index, level: atx.level, ...split });
      starts.add(index);
      continue;
    }

    const level = setextLevel(line);
    if (level === undefined || index === 0) continue;
    const titleIndex = index - 1;
    if (starts.has(titleIndex)) continue;
    if (!isSetextTitle(lines[titleIndex]?.text ?? "")) continue;
    const split = splitCustomId(lines[titleIndex]?.text ?? "");
    headings.push({ startIndex: titleIndex, level, ...split });
    starts.add(titleIndex);
  }
  return headings;
}

/** Separates a heading's visible text from a trailing `{#id}`. */
function splitCustomId(text: string): { readonly heading: string; readonly explicitId: string | undefined } {
  const match = CUSTOM_ID.exec(text);
  if (match === null) return { heading: text.trim(), explicitId: undefined };
  return { heading: text.slice(0, match.index).trim(), explicitId: match[1] };
}

/** Splits a document into its heading sections; the preamble is not one of them. */
function parseSections(source: string): ParsedSection[] {
  const lines = linesOf(source);
  const headings = headingsOf(lines);
  const counts = new Map<string, number>();
  const sections: ParsedSection[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    const next = headings[index + 1];

    const identity = heading.explicitId !== undefined
      ? `id:${heading.explicitId}`
      : `text:${normalized(heading.heading)}`;
    const occurrence = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, occurrence);

    const startLine = lines[heading.startIndex];
    if (startLine === undefined) continue;
    const endOffset = next === undefined
      ? source.length
      : (lines[next.startIndex]?.start ?? source.length);
    const endLine = next === undefined ? lines.length : next.startIndex;

    sections.push({
      heading: heading.heading,
      id: heading.explicitId ?? slugify(heading.heading),
      occurrence,
      key: `${identity}\u0000${occurrence}`,
      text: source.slice(startLine.start, endOffset),
      range: { start: heading.startIndex + 1, end: endLine },
    });
  }
  return sections;
}

/** The index pairs of a longest common subsequence of the two key sequences. */
function lcsPairs(oldKeys: readonly string[], newKeys: readonly string[]): LcsPair[] {
  const rows = oldKeys.length;
  const columns = newKeys.length;
  const width = columns + 1;
  const dp = new Uint32Array((rows + 1) * width);
  const at = (row: number, column: number): number => dp[row * width + column] ?? 0;

  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      dp[row * width + column] = oldKeys[row - 1] === newKeys[column - 1]
        ? at(row - 1, column - 1) + 1
        : Math.max(at(row - 1, column), at(row, column - 1));
    }
  }

  const pairs: LcsPair[] = [];
  let row = rows;
  let column = columns;
  while (row > 0 && column > 0) {
    if (oldKeys[row - 1] === newKeys[column - 1] && at(row, column) === at(row - 1, column - 1) + 1) {
      pairs.push({ oldIndex: row - 1, newIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (at(row - 1, column) >= at(row, column - 1)) {
      // On a tie, skip the old section: deterministic, and keeps the later old match.
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return pairs.reverse();
}

/**
 * Compares two Markdown documents by heading section.
 *
 * `added`, `changed`, and `moved` follow the new document's order; `removed` follows the old
 * document's order. Every section that is not `added`, `removed`, or `changed` is unchanged.
 */
export function diffMarkdown(oldText: string, newText: string): MarkdownDiff {
  const oldSections = parseSections(oldText);
  const newSections = parseSections(newText);

  const oldIndexByKey = new Map<string, number>();
  for (let index = 0; index < oldSections.length; index += 1) {
    const section = oldSections[index];
    if (section !== undefined) oldIndexByKey.set(section.key, index);
  }

  const inOrder = new Map<number, number>();
  for (const pair of lcsPairs(
    oldSections.map((section) => section.key),
    newSections.map((section) => section.key),
  )) {
    inOrder.set(pair.oldIndex, pair.newIndex);
  }

  const added: AddedSection[] = [];
  const changed: ChangedSection[] = [];
  const moved: MovedSection[] = [];
  const matchedOld = new Set<number>();

  for (let newIndex = 0; newIndex < newSections.length; newIndex += 1) {
    const section = newSections[newIndex];
    if (section === undefined) continue;
    const oldIndex = oldIndexByKey.get(section.key);
    if (oldIndex === undefined) {
      added.push({
        heading: section.heading,
        id: section.id,
        occurrence: section.occurrence,
        newText: section.text,
        newRange: section.range,
      });
      continue;
    }

    matchedOld.add(oldIndex);
    const oldSection = oldSections[oldIndex];
    if (oldSection === undefined) continue;

    const identity = {
      heading: section.heading,
      id: section.id,
      occurrence: section.occurrence,
    };
    const sides = {
      oldText: oldSection.text,
      oldRange: oldSection.range,
      newText: section.text,
      newRange: section.range,
    };

    if (inOrder.get(oldIndex) !== newIndex) {
      moved.push({ ...identity, ...sides });
    } else if (normalized(oldSection.text) !== normalized(section.text)) {
      changed.push({ ...identity, ...sides });
    }
  }

  const removed: RemovedSection[] = [];
  for (let oldIndex = 0; oldIndex < oldSections.length; oldIndex += 1) {
    const section = oldSections[oldIndex];
    if (section === undefined || matchedOld.has(oldIndex)) continue;
    removed.push({
      heading: section.heading,
      id: section.id,
      occurrence: section.occurrence,
      oldText: section.text,
      oldRange: section.range,
    });
  }

  return { added, removed, changed, moved };
}
