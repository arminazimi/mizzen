/**
 * Trims a set of pages to a token budget by dropping whole sections, from the least important end first.
 *
 * A page is split at its top-level headings: the lead (the title heading and the text before the
 * first section) and one section per heading, from a heading to the block before the next one.
 * The lead is the page's heading and first paragraph, and the first section is mandatory when the
 * page begins with a heading instead of a lead paragraph; a page with a single heading is all
 * lead. Mandatory content is never dropped, so a page keeps its heading and first paragraph even
 * when that alone costs more than the budget. Sections are atomic: a fenced code block is part of
 * one section and is never cut, and a `#` line inside a fence is code, not a heading.
 *
 * The budget covers the trimmed set as a whole: it is the sum of the pages' token estimates. The
 * input order is the caller's ranking, so dropping starts at the last page and its last section,
 * moves towards the first page, and stops at the first collection of mandatory content. The
 * `keep` option pins sections by id or heading text, and a pinned section can keep the output
 * above the budget; both over-budget cases are reported as diagnostics with a source position.
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
import { estimateTokens } from "./tokens.ts";

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
  /** The top-level sections that were dropped, in document order. */
  readonly droppedSections: readonly TrimSection[];
  /** The token estimate of {@link markdown}, by the configured estimator. */
  readonly tokens: number;
}

/** The trimmed pages and what could not be trimmed. */
export interface TrimResult {
  /** One entry per input page, in the input order. */
  readonly pages: readonly TrimmedPage[];
  /** Over-budget findings, in page order; empty when the output fits. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options for {@link trimPages}. */
export interface TrimOptions {
  /**
   * Counts the tokens of a text. Defaults to `estimateTokens(text).tokens`. An override is useful
   * for a caller that prices a particular vocabulary; the result is rounded up and clamped at 0.
   */
  readonly estimate?: (text: string) => number;
  /**
   * Section ids (block ids from {@link TrimSection.id}) and heading texts that are never dropped.
   * Pinned sections take precedence over the budget; an over-budget result is reported.
   */
  readonly keep?: readonly string[];
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
  /** The token estimate of the page as currently kept. Updated as sections are dropped. */
  tokens: number;
}

/** Estimates a text's tokens, rounding up, and clamps a missing or negative estimate to 0. */
function tokensOf(estimate: (text: string) => number, text: string): number {
  const value = estimate(text);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
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
    sections.filter((section) => section.mandatory),
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
    tokens: tokensOf(estimate, markdown),
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

/** A page's over-budget diagnostic: its mandatory content alone does not fit the budget. */
function pageDiagnostic(built: BuiltPage, limit: number, total: number): Diagnostic {
  return {
    id: "pack.trim.over-budget",
    severity: "warning",
    message: `The heading and first paragraph of ${built.page.url} take ${built.mandatoryTokens} tokens, above the budget of ${limit}; they are kept, and the output is ${total} tokens.`,
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

/**
 * Trims pages to a token budget by dropping whole trailing sections.
 *
 * The budget is the total token estimate of the result. While it is exceeded, the last kept
 * section of the last page in the input order is dropped; a page that has only its mandatory
 * content left is skipped and the previous page's last section is dropped. Mandatory content is
 * the lead (the title heading and the text before the first section) plus, when the lead has no
 * paragraph, the first section. Therefore every page keeps its heading and first paragraph.
 *
 * The result is deterministic: pages stay in the input order, sections in document order, and
 * parsing gives the same spans on every run. The input pages are not mutated.
 */
export async function trimPages(
  pages: readonly Page[],
  budget: number,
  options: TrimOptions = {},
): Promise<TrimResult> {
  const estimate = options.estimate ?? ((text: string): number => estimateTokens(text).tokens);
  const keep = new Set(options.keep ?? []);
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;

  const built: BuiltPage[] = [];
  for (const page of pages) built.push(await buildPage(page, estimate, keep));

  let total = built.reduce((sum, page) => sum + page.tokens, 0);
  let next = droppable(built);
  while (total > limit && next !== undefined) {
    const page = built[next.page]!;
    page.kept[next.section] = false;
    const before = page.tokens;
    page.tokens = tokensOf(estimate, assemble(page.lead, page.sections, page.kept));
    total += page.tokens - before;
    next = droppable(built);
  }

  const trimmed: TrimmedPage[] = built.map((page) => {
    const dropped = page.kept.some((keptSection) => !keptSection);
    return {
      url: page.page.url,
      markdown: dropped ? assemble(page.lead, page.sections, page.kept) : page.page.markdown,
      keptSections: page.sections.filter((_, index) => page.kept[index]),
      droppedSections: page.sections.filter((_, index) => !page.kept[index]),
      tokens: page.tokens,
    };
  });

  const diagnostics: Diagnostic[] = [];
  if (total > limit && built.length > 0) {
    const over = built.filter((page) => page.mandatoryTokens > limit);
    if (over.length > 0) {
      for (const page of over) diagnostics.push(pageDiagnostic(page, limit, total));
    } else {
      diagnostics.push(setDiagnostic(built[0]!.page, limit, total, built.length));
    }
  }

  return { pages: trimmed, diagnostics };
}
