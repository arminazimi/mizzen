/**
 * Trims a set of pages to a token budget without losing evidence the caller requires.
 *
 * A page is split at its top-level headings: the lead (the title heading and the text before the
 * first section) and one section per heading, from a heading to the block before the next one.
 * The lead is the page's heading and first paragraph, and the first section is mandatory when the
 * page begins with a heading instead of a lead paragraph; a page with a single heading is all
 * lead. Mandatory content is never dropped, so a page keeps its heading and first paragraph even
 * when that alone costs more than the budget. Sections are atomic: a fenced code block is part of
 * one section and is never cut, and a `#` line inside a fence is code, not a heading.
 *
 * **Budget allocation.** Required evidence — the caller's `required` items (source, version,
 * warnings, dependency information) and every page's mandatory content — is placed first in the
 * serialization and counted before any optional section. In the default `estimate` mode, the
 * optional sections are then dropped from the last page and its last section backwards, so the
 * input order is the caller's ranking. Required evidence is never trimmed: when it alone costs
 * more than the budget, it is kept whole, the output is over budget, and a warning names it. The
 * `keep` option pins further sections by id or heading text; a pinned section can also keep the
 * output above the budget, and both over-budget cases are reported as diagnostics with a source
 * position.
 *
 * **Hard limits.** `mode: "hard"` prices the complete serialization by the estimator's upper bound,
 * so a result reported as fitting has {@link TrimAccounting.upper} within the budget. Separators
 * are included because the whole serialization is measured, not its parts. `reservedTokens` is
 * taken off the budget before any optional section is considered and is never spent: when the
 * required evidence is smaller than the reserve, the difference still stays unavailable. Optional
 * sections are allocated in equal turns: each round visits the pages in the caller's ranking order
 * and lets each page add its next section when the whole serialization still fits, so one page
 * cannot take another's share; a page that cannot add its next section cannot add a later, larger
 * one. Ties fall to the input order, then to document order. Once near-duplicates have been removed
 * (§Diversification) the same equal-turn pass runs a second time over the optional sections still
 * omitted for budget, so the room a duplicate freed goes to unique content instead of leaving the
 * pack smaller than its budget: each round lets each page add its next omitted section, and a
 * section that repeats a kept one is never offered again. Every offer, in both passes, is priced
 * against the whole serialization's upper bound, the required evidence and the separators included.
 * Required evidence, mandatory content, and pinned sections are fixed; when they alone exceed the
 * limit the result is `status: "over-budget"`, with {@link TrimOverBudget.minimumUpper} reporting
 * the smallest feasible upper bound and every optional section reported as a `budget` omission.
 *
 * **The contract is measured on the serialization.** The budget applies to
 * {@link TrimResult.markdown}, the required evidence and the kept pages joined with one blank
 * line, not to the sum of per-page estimates: joining costs tokens too. The default measure is the
 * estimator's estimate, and {@link TrimAccounting.upper} reports the planning bound above it,
 * because no model-agnostic estimator is exact (see `tokens.ts`).
 *
 * **Diversification.** Once the budget is met, a kept section whose words repeat an earlier kept
 * section's is dropped as a near-duplicate: a short section must match exactly, while a longer one
 * must share {@link DUPLICATE_OVERLAP} of its distinct words. Deduplication runs after the budget,
 * so it only removes content that already survived, and it never costs a unique section its place.
 * In `hard` mode the budget a duplicate freed is then offered back to the unique sections the first
 * pass omitted for budget, in the same ranking order and document order; the default `estimate` mode
 * leaves that space unused, so its output bytes do not change. Every section left out is reported in
 * {@link TrimResult.omissions} with its reason, and the
 * required evidence is reported separately, so a caller can explain every omission and every
 * token. A section the budget left out is reported as a `duplicate`, with the link to its canonical
 * kept section, whenever a kept section carries its words: in `hard` mode the reason is read from
 * the final pack, so raising the budget would not bring such a section back.
 *
 * When the input already fits, each page's Markdown is returned byte for byte. Otherwise the kept
 * lead and sections are joined with one blank line between them, so the output is a deterministic
 * function of the input: no disk, clock, network, or environment is read. Parsing happens through
 * {@link parseMarkdown}, so positions refer to the page's source file, starting at
 * `page.source.line`.
 */

import type { Heading, Nodes, Root, RootContent } from "mdast";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Page } from "../contracts/content.ts";
import type { SourcePos } from "../contracts/source.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { blockIdOf, spanFromPosition } from "../source/spans.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "./tokens.ts";

/** Distinct words a section needs before near-duplicate matching applies; shorter sections must match exactly. */
const DUPLICATE_MIN_WORDS = 12;

/** The share of two sections' distinct words that makes them near-duplicates. */
const DUPLICATE_OVERLAP = 0.8;

/** The words a section is compared by, case-folded: Markdown syntax and whitespace do not matter. */
const WORD = /[\p{L}\p{N}]+/gu;

/** One top-level heading and the blocks under it, up to the next top-level heading. */
export interface TrimSection {
  /** The heading's block id, `<file>:<line>:<column>`. Matches a `keep` entry. */
  readonly id: string;
  /** The heading's plain text. Matches a `keep` entry, exactly and case-sensitively. */
  readonly text: string;
  /** The heading's span in the page's source file. */
  readonly pos: SourcePos;
  /** The section's Markdown, as written except for trailing whitespace. */
  readonly markdown: string;
  /** The section's token estimate, by the configured estimator. */
  readonly tokens: number;
}

/** One page after trimming. */
export interface TrimmedPage {
  /** The page's output URL, unchanged. */
  readonly url: string;
  /** The kept Markdown: the whole page when it fit, else the lead and the kept sections. */
  readonly markdown: string;
  /** The top-level sections that were kept, in document order. */
  readonly keptSections: readonly TrimSection[];
  /** The top-level sections that were dropped, in document order, for either reason. */
  readonly droppedSections: readonly TrimSection[];
  /** The token estimate of {@link markdown}, by the configured estimator. */
  readonly tokens: number;
}

/**
 * A piece of evidence the caller requires, such as a source path, a version, a build warning, or a
 * dependency note. `trimPages` keeps it whole and prices it before optional content; it does not
 * interpret the text or the kind.
 */
export interface RequiredEvidence {
  /** Stable id, echoed in {@link TrimResult.required}; the caller maps it into its own output. */
  readonly id: string;
  /** What the item is, such as `source`, `version`, `warning`, or `dependency`. */
  readonly kind: string;
  /** The exact Markdown kept before the optional content in {@link TrimResult.markdown}. */
  readonly text: string;
  /** Where the item came from, when it has a place; an over-budget diagnostic prefers it. */
  readonly pos?: SourcePos;
}

/** Why a section is missing from the output. */
export type TrimOmissionReason = "budget" | "duplicate";

/** One section that was left out, and why. */
export interface TrimOmission {
  /** The page the section belongs to. */
  readonly url: string;
  /** The heading's block id, `<file>:<line>:<column>`. */
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
  /** The section's token estimate, by the configured estimator. */
  readonly tokens: number;
  /** The heading's span in the page's source file. */
  readonly pos: SourcePos;
  /**
   * `budget` when the budget could not keep it, `duplicate` when a kept section repeats it. Hard mode reads the
   * reason from the final pack, so a section the budget left out first still counts as a duplicate once its
   * content survives elsewhere; estimate mode reports the duplicates its own pass removed.
   */
  readonly reason: TrimOmissionReason;
  /** The kept section this one repeated, when the reason is `duplicate`; `undefined` otherwise. */
  readonly duplicateOf: { readonly url: string; readonly id: string } | undefined;
}

/** How a budget is enforced. */
export type TrimMode = "estimate" | "hard";

/** Whether a result fits the limit its mode measures. */
export type TrimStatus = "fits" | "over-budget";

/**
 * The smallest feasible result, reported when the content that may not be dropped is alone over the
 * limit. The accounting values are exact upper bounds, so a caller can see how far over the budget
 * its mandatory requirements are.
 */
export interface TrimOverBudget {
  /** The effective limit: {@link TrimAccounting.budget} minus {@link TrimAccounting.reserved}. */
  readonly limit: number;
  /** The upper bound of the smallest possible serialization: required evidence, mandatory content, and pinned sections. */
  readonly minimumUpper: number;
  /** How far {@link minimumUpper} exceeds {@link limit}; never negative. */
  readonly missingUpper: number;
  /** The upper bound of the required evidence and mandatory content alone, without pinned sections. */
  readonly requiredUpper: number;
}

/** The token accounting of a trimmed result, so a caller can inspect every number the contract used. */
export interface TrimAccounting {
  /** The budget the caller asked for, after rounding down and clamping at 0. */
  readonly budget: number;
  /** Tokens held back from optional content: the requested reserve, rounded down and clamped at 0. */
  readonly reserved: number;
  /** The effective limit: {@link budget} minus {@link reserved}, clamped at 0. */
  readonly limit: number;
  /** The estimate of {@link TrimResult.markdown}, the serialized result. */
  readonly tokens: number;
  /** {@link tokens} grown by {@link margin}: a planning bound that a hard limit reserves. */
  readonly upper: number;
  /** The estimate of the required evidence and each page's mandatory content alone. */
  readonly required: number;
  /** {@link required} grown by {@link margin}, for the same reason as {@link upper}. */
  readonly requiredUpper: number;
  /** The upper bound of the smallest possible serialization, pinned sections included. */
  readonly minimumUpper: number;
  /** {@link limit} minus {@link upper}, clamped at 0: headroom the output leaves unused. */
  readonly remaining: number;
  /** The estimator's name: {@link TOKEN_METHOD} by default, `custom` for an override. */
  readonly method: string;
  /** The relative margin behind {@link upper}; 0 for a custom estimator, which states its own. */
  readonly margin: number;
}

/** The trimmed pages and what could not be trimmed. */
export interface TrimResult {
  /** One entry per input page, in the input order. */
  readonly pages: readonly TrimmedPage[];
  /** Over-budget findings, in page order; empty when the output fits. */
  readonly diagnostics: readonly Diagnostic[];
  /** The required evidence that was kept, in the input order, with empty text removed. */
  readonly required: readonly RequiredEvidence[];
  /**
   * The canonical serialization: the required evidence first, then the pages, one blank line
   * between parts. This is the text the budget contract measures.
   */
  readonly markdown: string;
  /** How the budget was spent, with the estimator's uncertainty. */
  readonly accounting: TrimAccounting;
  /** `fits` when the result meets its mode's limit; `over-budget` when the fixed content alone cannot. */
  readonly status: TrimStatus;
  /** What the smallest feasible serialization would cost, when even it exceeds the limit; else `undefined`. */
  readonly overBudget: TrimOverBudget | undefined;
  /** Every section left out and why, in page and document order. */
  readonly omissions: readonly TrimOmission[];
}

/** Options for {@link trimPages}. */
export interface TrimOptions {
  /**
   * Counts the tokens of a text. Defaults to `estimateTokens(text).tokens`. An override is useful
   * for a caller that prices a particular vocabulary; it must return a finite, non-negative number,
   * which is rounded up. Zero is valid; any other unusable result is refused with
   * {@link TrimEstimateError}. A custom estimator reports no margin, because this module cannot
   * know its error.
   */
  readonly estimate?: (text: string) => number;
  /**
   * How the budget is enforced. `estimate` (the default) drops sections while the estimate exceeds
   * it, so the estimator's margin may sit above the budget; `hard` keeps the whole serialization's
   * upper bound inside it.
   */
  readonly mode?: TrimMode;
  /**
   * Tokens held back from optional content, for a caller's own prompt or tool output. The reserve
   * reduces the effective limit and is never spent, even when the required evidence is smaller
   * than it. Default `0`.
   */
  readonly reservedTokens?: number;
  /**
   * Section ids (block ids from {@link TrimSection.id}) and heading texts that are never dropped.
   * Pinned sections take precedence over the budget; an over-budget result is reported.
   */
  readonly keep?: readonly string[];
  /**
   * Evidence that must survive whatever the budget: source, version, warnings, and dependency
   * information. It is counted before optional sections and never trimmed; when it alone exceeds
   * the budget the output is over budget and the finding id is `pack.trim.required-over-budget`.
   */
  readonly required?: readonly RequiredEvidence[];
}

/** A section as building and trimming see it: its description plus whether it may be dropped. */
interface BuiltSection extends TrimSection {
  /** Mandatory sections are the page's heading and first paragraph and are never dropped. */
  readonly mandatory: boolean;
  /** A section named by `keep`; pinned sections are not dropped until nothing else is left. */
  readonly pinned: boolean;
}

/** A page split into its lead and sections, with what trimming needs to know. */
interface BuiltPage {
  readonly page: Page;
  /** The page's Markdown before the first section, or the whole page when it has no split section. */
  readonly lead: string;
  /** The sections, in document order. */
  readonly sections: readonly BuiltSection[];
  /** Whether each section is in the output. Mutated by trimming. */
  readonly kept: boolean[];
  /** The token estimate of the mandatory content alone. */
  readonly mandatoryTokens: number;
  /** The first mandatory block's span, used to place an over-budget diagnostic. */
  readonly mandatoryPos: SourcePos;
}

/** A section's words, for near-duplicate comparison. */
interface Signature {
  /** The words joined by one space: two sections with the same words in the same order match exactly. */
  readonly text: string;
  /** The distinct words. */
  readonly words: ReadonlySet<string>;
}

/** Raised when a token estimator returns a value that cannot be a token count. */
export class TrimEstimateError extends Error {
  /** The value the estimator returned. */
  readonly value: unknown;

  constructor(value: unknown) {
    super(`the token estimator returned ${String(value)}, which is not a finite, non-negative number`);
    this.name = "TrimEstimateError";
    this.value = value;
  }
}

/**
 * Estimates a text's tokens, rounding a positive result up. Zero is valid; every other unusable
 * result is refused rather than clamped, so a broken estimator cannot make content look free.
 */
function tokensOf(estimate: (text: string) => number, text: string): number {
  const value = estimate(text);
  if (!Number.isFinite(value) || value < 0) throw new TrimEstimateError(value);
  return value > 0 ? Math.ceil(value) : 0;
}

/** Grows a token count by a relative margin, rounding up: the planning upper bound. */
function upperOf(tokens: number, margin: number): number {
  return Math.ceil(tokens * (1 + margin));
}

/** Joins the non-empty parts with one blank line: the serialization the budget contract measures. */
function serializeParts(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

/** The required evidence that carries text, in the input order. */
function evidenceOf(required: readonly RequiredEvidence[] | undefined): readonly RequiredEvidence[] {
  return (required ?? []).filter((item) => typeof item.text === "string" && item.text.trim() !== "");
}

/** A node's start offset in the parsed body. `remark` sets it on every node and plugin-created node. */
function startOffset(node: RootContent): number {
  return node.position?.start.offset ?? 0;
}

/** A node's end offset in the parsed body; `remark`'s end is exclusive. */
function endOffset(node: RootContent): number {
  return node.position?.end.offset ?? 0;
}

/** The plain text of a node: its value, or its children's text joined. */
function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

/** A node's span in its source file, or undefined when the node carries no position. */
function spanOfNode(file: string, node: RootContent | undefined): SourcePos | undefined {
  const position = node?.position;
  return position ? spanFromPosition(file, position) : undefined;
}

/** A heading node's depth, which decides whether it starts a section. */
function headingDepth(node: RootContent): number | undefined {
  return node.type === "heading" ? node.depth : undefined;
}

/**
 * The depth at which the page is split, or undefined when the page is all lead.
 *
 * A leading heading shallower than every other heading is the page's title and does not split:
 * `# Title` followed by `##` sections are one lead plus sections at depth 2. A page that starts
 * at its section depth (`##` sections with the title in front matter) splits there, so its first
 * section supplies the heading and first paragraph. A page with fewer than two headings has no
 * section to drop.
 */
function splitDepthOf(headings: readonly Heading[]): number | undefined {
  if (headings.length < 2) return undefined;
  // A leading title heading is below the shallowest section heading and does not split; the
  // shallowest heading after the first always does, whether or not it is deeper than the first.
  return Math.min(...headings.slice(1).map((heading) => heading.depth));
}

/** Splits the top-level children at the given depth and slices the sections out of the Markdown. */
function sectionsOf(
  tree: Root,
  markdown: string,
  file: string,
  depth: number,
  estimate: (text: string) => number,
  keep: ReadonlySet<string>,
  firstIsMandatory: boolean,
): readonly BuiltSection[] {
  const indexes: number[] = [];
  for (let index = 0; index < tree.children.length; index += 1) {
    if (headingDepth(tree.children[index]!) === depth) indexes.push(index);
  }

  const sections: BuiltSection[] = [];
  for (let position = 0; position < indexes.length; position += 1) {
    const from = indexes[position]!;
    const to = indexes[position + 1] ?? tree.children.length;
    const heading = tree.children[from]!;
    const last = tree.children[to - 1]!;
    const sectionMarkdown = markdown.slice(startOffset(heading), endOffset(last)).trimEnd();
    const pos = spanOfNode(file, heading) ?? { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
    const text = textOf(heading).trim();
    const id = blockIdOf(pos);
    sections.push({
      id,
      text,
      pos,
      markdown: sectionMarkdown,
      tokens: tokensOf(estimate, sectionMarkdown),
      mandatory: position === 0 && firstIsMandatory,
      pinned: keep.has(id) || keep.has(text),
    });
  }
  return sections;
}

/** Joins the lead and the kept sections with one blank line between them. */
function assemble(lead: string, sections: readonly BuiltSection[], kept: readonly boolean[]): string {
  const parts: string[] = [];
  if (lead !== "") parts.push(lead);
  for (let index = 0; index < sections.length; index += 1) {
    if (kept[index]) parts.push(sections[index]!.markdown);
  }
  return parts.join("\n\n");
}

/** A page's Markdown with the sections the predicate keeps; the original text when every section is kept. */
function renderPage(page: BuiltPage, keep: (section: BuiltSection, index: number) => boolean): string {
  return page.sections.every((section, index) => keep(section, index))
    ? page.page.markdown
    : assemble(page.lead, page.sections, page.sections.map((section, index) => keep(section, index)));
}

/** A page's Markdown after trimming; the original text when nothing was dropped. */
function pageMarkdown(page: BuiltPage): string {
  return renderPage(page, (_section, index) => page.kept[index]!);
}

/** A page's smallest possible Markdown: its mandatory content and its pinned sections. */
function fixedMarkdown(page: BuiltPage): string {
  return renderPage(page, (section) => section.mandatory || section.pinned);
}

/** A page's mandatory content: its lead and its mandatory sections. */
function mandatoryMarkdown(page: BuiltPage): string {
  return assemble(page.lead, page.sections, page.sections.map((section) => section.mandatory));
}

/** The serialized token estimate of the required evidence and the kept pages. */
function totalOf(
  built: readonly BuiltPage[],
  evidence: readonly RequiredEvidence[],
  estimate: (text: string) => number,
): number {
  return tokensOf(estimate, serializeParts([...evidence.map((item) => item.text), ...built.map(pageMarkdown)]));
}

/** Parses and splits one page, and measures its mandatory content. */
async function buildPage(
  page: Page,
  estimate: (text: string) => number,
  keep: ReadonlySet<string>,
): Promise<BuiltPage> {
  const markdown = page.markdown;
  const tree = await parseMarkdown(markdown, page.source.line);
  const children = tree.children;
  const headings = children.filter((node): node is Heading => node.type === "heading");
  const depth = splitDepthOf(headings);

  const splitIndex = depth === undefined ? -1 : children.findIndex((node) => headingDepth(node) === depth);
  const lead = markdown.slice(0, splitIndex === -1 ? markdown.length : startOffset(children[splitIndex]!)).trimEnd();
  const leadNodes = splitIndex === -1 ? children : children.slice(0, splitIndex);
  const firstIsMandatory = !leadNodes.some((node) => node.type === "paragraph");
  const sections = depth === undefined || splitIndex === -1 ? [] : sectionsOf(tree, markdown, page.source.file, depth, estimate, keep, firstIsMandatory);
  const kept = sections.map(() => true);

  const mandatoryText = assemble(
    lead,
    sections,
    sections.map((section) => section.mandatory),
  );
  const mandatoryPos =
    spanOfNode(page.source.file, leadNodes[0]) ??
    spanOfNode(page.source.file, splitIndex === -1 ? undefined : children[splitIndex]) ??
    page.source;

  return {
    page,
    lead,
    sections,
    kept,
    mandatoryTokens: tokensOf(estimate, mandatoryText),
    mandatoryPos,
  };
}

/** The next section to drop: the last kept section that is neither mandatory nor pinned. */
function droppable(pages: readonly BuiltPage[]): { page: number; section: number } | undefined {
  for (let page = pages.length - 1; page >= 0; page -= 1) {
    const built = pages[page]!;
    for (let section = built.sections.length - 1; section >= 0; section -= 1) {
      const candidate = built.sections[section]!;
      if (built.kept[section] && !candidate.mandatory && !candidate.pinned) return { page, section };
    }
  }
  return undefined;
}

/** The next section a page may add, from `from`; mandatory and pinned sections are skipped. */
function nextDroppable(page: BuiltPage, from: number): number {
  for (let index = from; index < page.sections.length; index += 1) {
    const section = page.sections[index]!;
    if (!section.mandatory && !section.pinned) return index;
  }
  return -1;
}

/**
 * Allocates optional sections in equal turns and keeps the whole serialization inside the limit.
 *
 * Each round visits the pages in the caller's ranking order, and every page may add its next
 * section when the upper bound of the complete serialization still fits. So one page cannot take
 * another page's turn, and a page that cannot add its next section cannot add a later, larger one.
 * Ties fall to the input order, then to document order. Required evidence, mandatory content, and
 * pinned sections are already kept and are never touched.
 */
function allocateFair(
  built: readonly BuiltPage[],
  evidence: readonly RequiredEvidence[],
  estimate: (text: string) => number,
  limit: number,
  margin: number,
): void {
  const cursors: number[] = [];
  for (const page of built) {
    const first = nextDroppable(page, 0);
    for (let index = first; index !== -1; index = nextDroppable(page, index + 1)) {
      page.kept[index] = false;
    }
    cursors.push(first);
  }

  while (cursors.some((cursor) => cursor !== -1)) {
    let progress = false;
    for (let index = 0; index < built.length; index += 1) {
      const page = built[index]!;
      const cursor = cursors[index]!;
      if (cursor === -1) continue;
      page.kept[cursor] = true;
      if (upperOf(totalOf(built, evidence, estimate), margin) <= limit) {
        progress = true;
        cursors[index] = nextDroppable(page, cursor + 1);
      } else {
        page.kept[cursor] = false;
        cursors[index] = -1;
      }
    }
    if (!progress) break;
  }
}

/** A section's words, for near-duplicate comparison. */
function signatureOf(markdown: string): Signature {
  const words = markdown.toLowerCase().match(WORD) ?? [];
  return { text: words.join(" "), words: new Set(words) };
}

/** A kept section, with the page it came from and the words a later section is compared against. */
interface Canonical {
  readonly url: string;
  readonly section: BuiltSection;
  readonly signature: Signature;
}

/** The link from an omitted section to the kept section whose content it repeats. */
type DuplicateLinks = ReadonlyMap<BuiltSection, { readonly url: string; readonly id: string }>;

/** The kept sections, in page and document order, as the near-duplicate comparison sees them. */
function canonicalOf(built: readonly BuiltPage[]): Canonical[] {
  const canonical: Canonical[] = [];
  for (const page of built) {
    for (let index = 0; index < page.sections.length; index += 1) {
      if (!page.kept[index]) continue;
      const section = page.sections[index]!;
      canonical.push({ url: page.page.url, section, signature: signatureOf(section.markdown) });
    }
  }
  return canonical;
}

/** Whether any of `canonical` already carries the section's words. */
function repeatsAny(canonical: readonly Canonical[], section: BuiltSection): boolean {
  const signature = signatureOf(section.markdown);
  return canonical.some((entry) => isDuplicate(entry.signature, signature));
}

/**
 * Whether two sections repeat each other. A section with fewer than {@link DUPLICATE_MIN_WORDS}
 * distinct words has to match exactly; a longer one is a near-duplicate when it shares
 * {@link DUPLICATE_OVERLAP} of the two sections' distinct words.
 */
function isDuplicate(a: Signature, b: Signature): boolean {
  if (a.text === b.text) return a.text !== "";
  if (a.words.size < DUPLICATE_MIN_WORDS || b.words.size < DUPLICATE_MIN_WORDS) return false;
  let shared = 0;
  for (const word of a.words) if (b.words.has(word)) shared += 1;
  return shared / (a.words.size + b.words.size - shared) >= DUPLICATE_OVERLAP;
}

/**
 * Drops each kept section that repeats an earlier kept section, in page and document order. Mandatory and
 * pinned sections are never dropped; they can still be the earlier section that later ones repeat.
 */
function removeDuplicates(built: readonly BuiltPage[]): DuplicateLinks {
  const canonical: { readonly url: string; readonly section: BuiltSection; readonly signature: Signature }[] = [];
  const duplicates = new Map<BuiltSection, { url: string; id: string }>();
  for (const page of built) {
    for (let index = 0; index < page.sections.length; index += 1) {
      const section = page.sections[index]!;
      if (!page.kept[index]) continue;
      const signature = signatureOf(section.markdown);
      const first = canonical.find((entry) => isDuplicate(entry.signature, signature));
      if (first !== undefined && !section.mandatory && !section.pinned) {
        page.kept[index] = false;
        duplicates.set(section, { url: first.url, id: first.section.id });
        continue;
      }
      canonical.push({ url: page.page.url, section, signature });
    }
  }
  return duplicates;
}

/**
 * The next section a page may be offered the freed budget for, from `from`. Mandatory and pinned sections are
 * fixed, kept sections are already in the pack, and a section a kept section repeats is never offered, because
 * readmitting it would only put the duplicate back.
 */
function nextReclaimable(page: BuiltPage, from: number, canonical: readonly Canonical[]): number {
  for (let index = from; index < page.sections.length; index += 1) {
    const section = page.sections[index]!;
    if (page.kept[index] || section.mandatory || section.pinned) continue;
    if (repeatsAny(canonical, section)) continue;
    return index;
  }
  return -1;
}

/**
 * Offers the budget that removing a duplicate freed back to the unique sections the budget omitted (#111).
 *
 * The second hard-mode allocation pass follows the same rules as {@link allocateFair}: each round visits the
 * pages in the caller's ranking order and lets each page add its next omitted section, so one page cannot take
 * another's share, and a page that cannot add its next section cannot add a later, larger one. A candidate is
 * priced against the whole serialization's upper bound, the required evidence and the separators included, and
 * only unique sections are offered, so deduplication's saving goes to useful content without admitting a repeat.
 * Before each turn the page is re-scanned from its cursor against the canonical sections kept so far, so a section
 * a higher-ranked page admitted in the same round is skipped rather than readmitted as a fresh duplicate. Every
 * cursor moves only forward and each round either admits a section or retires a cursor, so the pass terminates.
 */
function reclaimFreed(
  built: readonly BuiltPage[],
  evidence: readonly RequiredEvidence[],
  estimate: (text: string) => number,
  limit: number,
  margin: number,
  canonical: Canonical[],
): void {
  const cursors: number[] = built.map((page) => nextReclaimable(page, 0, canonical));

  while (cursors.some((cursor) => cursor !== -1)) {
    let progress = false;
    for (let index = 0; index < built.length; index += 1) {
      if (cursors[index] === -1) continue;
      const page = built[index]!;
      // Re-scan from the cursor against the sections kept so far, including any a higher-ranked page admitted this
      // round: one that now repeats a kept section is skipped, so the pass never re-admits a duplicate (#111).
      const cursor = nextReclaimable(page, cursors[index]!, canonical);
      cursors[index] = cursor;
      if (cursor === -1) continue;
      page.kept[cursor] = true;
      if (upperOf(totalOf(built, evidence, estimate), margin) <= limit) {
        const section = page.sections[cursor]!;
        canonical.push({ url: page.page.url, section, signature: signatureOf(section.markdown) });
        progress = true;
        cursors[index] = cursor + 1;
      } else {
        page.kept[cursor] = false;
        cursors[index] = -1;
      }
    }
    if (!progress) break;
  }
}

/**
 * The kept section each omitted section repeats, in page and document order.
 *
 * {@link removeDuplicates} links the sections it drops itself; after the reallocation an omitted section can
 * repeat a kept one without ever having been dropped, because the budget left it out first. Raising the budget
 * would not bring such a section back, so its reason is the duplicate link rather than `budget` (#111).
 */
function linksOf(built: readonly BuiltPage[]): DuplicateLinks {
  const links = new Map<BuiltSection, { readonly url: string; readonly id: string }>();
  const canonical: Canonical[] = [];
  for (const page of built) {
    for (let index = 0; index < page.sections.length; index += 1) {
      const section = page.sections[index]!;
      if (page.kept[index]) {
        canonical.push({ url: page.page.url, section, signature: signatureOf(section.markdown) });
        continue;
      }
      const signature = signatureOf(section.markdown);
      const first = canonical.find((entry) => isDuplicate(entry.signature, signature));
      if (first !== undefined) links.set(section, { url: first.url, id: first.section.id });
    }
  }
  return links;
}

/** Every section left out, in page and document order, with its reason. */
function omissionsOf(
  built: readonly BuiltPage[],
  duplicates: ReadonlyMap<BuiltSection, { url: string; id: string }>,
): readonly TrimOmission[] {
  const omissions: TrimOmission[] = [];
  for (const page of built) {
    for (let index = 0; index < page.sections.length; index += 1) {
      if (page.kept[index]) continue;
      const section = page.sections[index]!;
      const duplicateOf = duplicates.get(section);
      omissions.push({
        url: page.page.url,
        id: section.id,
        text: section.text,
        tokens: section.tokens,
        pos: section.pos,
        reason: duplicateOf === undefined ? "budget" : "duplicate",
        duplicateOf,
      });
    }
  }
  return omissions;
}

/** A page's over-budget diagnostic: its mandatory content alone does not fit the budget. */
function pageDiagnostic(built: BuiltPage, limit: number, total: number, cost = built.mandatoryTokens): Diagnostic {
  return {
    id: "pack.trim.over-budget",
    severity: "warning",
    message: `The heading and first paragraph of ${built.page.url} take ${cost} tokens, above the budget of ${limit}; they are kept, and the output is ${total} tokens.`,
    pos: built.mandatoryPos,
    help: "Raise the budget, or use `keep` deliberately: mandatory content is never dropped.",
  };
}

/** The over-budget diagnostic for several pages whose mandatory content adds up past the budget. */
function setDiagnostic(first: Page, limit: number, total: number, count: number): Diagnostic {
  return {
    id: "pack.trim.over-budget",
    severity: "warning",
    message: `Trimmed ${count} pages to ${total} tokens, above the budget of ${limit}: each page's heading and first paragraph are kept, and no droppable section is left.`,
    pos: first.source,
    help: "Raise the budget or rank fewer pages; mandatory content is never dropped.",
  };
}

/** The over-budget diagnostic for required evidence that cannot fit on its own. */
function requiredDiagnostic(
  evidence: readonly RequiredEvidence[],
  evidenceTokens: number,
  limit: number,
  total: number,
): Diagnostic {
  const diagnostic: Diagnostic = {
    id: "pack.trim.required-over-budget",
    severity: "warning",
    message: `The required evidence takes ${evidenceTokens} tokens, above the budget of ${limit}; it is kept whole, and the output is ${total} tokens.`,
    help: "Raise the budget, or remove required evidence deliberately: required evidence is never trimmed.",
  };
  const pos = evidence.find((item) => item.pos !== undefined)?.pos;
  return pos === undefined ? diagnostic : { ...diagnostic, pos };
}

/**
 * Trims pages to a token budget by dropping whole sections, then near-duplicates.
 *
 * The budget is the total of {@link TrimResult.markdown}: the required evidence first, then the
 * pages in the input order, joined with one blank line between parts. In the default `estimate`
 * mode, while the estimate is exceeded the last kept section of the last page in the input order is
 * dropped; a page that has only its mandatory content left is skipped and the previous page's last
 * section is dropped. In `hard` mode the whole serialization is priced by the estimator's upper
 * bound, `reservedTokens` is taken off the budget, and optional sections are kept in equal turns
 * across the pages (see `allocateFair`). Mandatory content is the lead (the title heading and the
 * text before the first section) plus, when the lead has no paragraph, the first section.
 * Therefore every page keeps its heading and first paragraph, and the required evidence is always
 * kept.
 *
 * After the budget is met, a kept section that repeats an earlier kept section is dropped and
 * reported as a `duplicate` omission. The result is deterministic: pages stay in the input order,
 * sections in document order, and parsing gives the same spans on every run. The input pages are
 * not mutated.
 */
export async function trimPages(
  pages: readonly Page[],
  budget: number,
  options: TrimOptions = {},
): Promise<TrimResult> {
  const estimate = options.estimate ?? ((text: string): number => estimateTokens(text).tokens);
  const margin = options.estimate === undefined ? TOKEN_ERROR_MARGIN : 0;
  const method = options.estimate === undefined ? TOKEN_METHOD : "custom";
  const hard = options.mode === "hard";
  const keep = new Set(options.keep ?? []);
  const evidence = evidenceOf(options.required);
  const budgetLimit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const requestedReserve = options.reservedTokens ?? 0;
  const reserved = Number.isFinite(requestedReserve) ? Math.max(0, Math.floor(requestedReserve)) : 0;
  const limit = Math.max(0, budgetLimit - reserved);

  const built: BuiltPage[] = [];
  for (const page of pages) built.push(await buildPage(page, estimate, keep));

  if (hard) {
    allocateFair(built, evidence, estimate, limit, margin);
  } else {
    let total = totalOf(built, evidence, estimate);
    let next = droppable(built);
    while (total > limit && next !== undefined) {
      built[next.page]!.kept[next.section] = false;
      total = totalOf(built, evidence, estimate);
      next = droppable(built);
    }
  }

  const removed = removeDuplicates(built);
  // #111: a duplicate that gave way leaves room the unique sections the first pass omitted can still use, and the
  // reasons are read from the final pack, so an omission a kept section already covers is reported as a duplicate
  // whether deduplication removed it or the budget left it out first. Only hard mode spends the freed budget, so
  // the default estimate mode's output bytes do not change.
  let duplicates: DuplicateLinks = removed;
  if (hard) {
    if (removed.size > 0) reclaimFreed(built, evidence, estimate, limit, margin, canonicalOf(built));
    duplicates = linksOf(built);
  }

  const markdown = serializeParts([...evidence.map((item) => item.text), ...built.map(pageMarkdown)]);
  const tokens = tokensOf(estimate, markdown);
  const upper = upperOf(tokens, margin);
  const required = tokensOf(
    estimate,
    serializeParts([...evidence.map((item) => item.text), ...built.map(mandatoryMarkdown)]),
  );
  const requiredUpper = upperOf(required, margin);
  const minimumUpper = upperOf(
    tokensOf(estimate, serializeParts([...evidence.map((item) => item.text), ...built.map(fixedMarkdown)])),
    margin,
  );

  const trimmed: TrimmedPage[] = built.map((page) => {
    const pageText = pageMarkdown(page);
    return {
      url: page.page.url,
      markdown: pageText,
      keptSections: page.sections.filter((_, index) => page.kept[index]),
      droppedSections: page.sections.filter((_, index) => !page.kept[index]),
      tokens: tokensOf(estimate, pageText),
    };
  });

  // The mode's measure: a hard limit must fit the upper bound, the default one the estimate.
  const measure = hard ? upper : tokens;
  const status: TrimStatus = measure <= limit ? "fits" : "over-budget";
  const overBudget: TrimOverBudget | undefined =
    status === "fits"
      ? undefined
      : { limit, minimumUpper, missingUpper: Math.max(0, minimumUpper - limit), requiredUpper };

  const diagnostics: Diagnostic[] = [];
  if (measure > limit) {
    const evidenceMeasure = hard
      ? upperOf(tokensOf(estimate, serializeParts(evidence.map((item) => item.text))), margin)
      : tokensOf(estimate, serializeParts(evidence.map((item) => item.text)));
    if (evidence.length > 0 && evidenceMeasure > limit) {
      diagnostics.push(requiredDiagnostic(evidence, evidenceMeasure, limit, measure));
    } else if (built.length > 0) {
      const over = built.filter((page) => (hard ? upperOf(page.mandatoryTokens, margin) : page.mandatoryTokens) > limit);
      if (over.length > 0) {
        for (const page of over) {
          const cost = hard ? upperOf(page.mandatoryTokens, margin) : page.mandatoryTokens;
          diagnostics.push(pageDiagnostic(page, limit, measure, cost));
        }
      } else {
        diagnostics.push(setDiagnostic(built[0]!.page, limit, measure, built.length));
      }
    }
  }

  return {
    pages: trimmed,
    diagnostics,
    required: evidence,
    markdown,
    accounting: {
      budget: budgetLimit,
      reserved,
      limit,
      tokens,
      upper,
      required,
      requiredUpper,
      minimumUpper,
      remaining: Math.max(0, limit - upper),
      method,
      margin,
    },
    status,
    overBudget,
    omissions: omissionsOf(built, duplicates),
  };
}
