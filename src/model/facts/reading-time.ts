import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Page } from "../../contracts/index.ts";
import type { Fact } from "../facts.ts";

/** The reading rate used when a caller does not choose one: 200 words per minute. */
export const DEFAULT_WORDS_PER_MINUTE = 200;

/** Options of the reading-time helpers. */
export interface ReadingTimeOptions {
  /** Words read per minute. A missing, non-finite, or non-positive value falls back to {@link DEFAULT_WORDS_PER_MINUTE}. */
  readonly wordsPerMinute?: number;
}

/** One doc page's reading time, as `Site.data["reading-time"]` and `reading-time.json` carry it. */
export interface ReadingTimePage {
  /** Output URL, including `base`. */
  readonly url: string;
  /** Words in the page's prose, as {@link countWords} counts them. */
  readonly words: number;
  /** Reading time in whole minutes, the word count divided by the rate and rounded up. */
  readonly minutes: number;
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
}

/** A node of the Markdown tree; only the fields this unit reads are named. */
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
}

/** Nodes whose text is not prose: code, images, link definitions, and rules. */
const NOT_PROSE = new Set(["code", "inlineCode", "image", "imageReference", "definition", "thematicBreak", "yaml", "toml"]);

/** One CJK, Han, Kana, or Hangul code point; each counts as one word. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** The same set, global, for taking CJK out of the text before word segmentation. */
const CJK_ALL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Unicode word boundaries (UAX #29). The locale only fixes the segmentation data; the boundaries are script-aware,
 * so Latin, Cyrillic, Arabic, and Persian text segment the same way. An explicit locale keeps the result independent
 * of the machine's default locale.
 */
const WORDS = new Intl.Segmenter("en", { granularity: "word" });

/** Parses Markdown to the tree the counter walks, with the GFM and directive syntax a page may use. */
const PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkDirective);

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The text of a raw HTML fragment with its tags, comments, and embedded code removed; the prose between tags stays. */
function htmlText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

/** Collects the prose of one node. Each text run is its own part, so adjacent blocks never merge into one word. */
function collect(node: MarkdownNode, parts: string[]): void {
  if (NOT_PROSE.has(node.type)) return;
  if (node.type === "text") {
    if (node.value !== undefined) parts.push(node.value);
    return;
  }
  if (node.type === "html") {
    if (node.value !== undefined) parts.push(htmlText(node.value));
    return;
  }
  for (const child of node.children ?? []) collect(child, parts);
}

/**
 * The prose of a Markdown body, with fenced and inline code, images, link definitions, and HTML tags removed.
 * Front matter is already absent from `Page.markdown`. Text between HTML tags is kept, as a browser renders it.
 */
function proseOf(markdown: string): string {
  const tree = PARSER.parse(markdown) as unknown as MarkdownNode;
  const parts: string[] = [];
  collect(tree, parts);
  return parts.join(" ");
}

/**
 * Counts the words in a Markdown body.
 *
 * Fenced code, indented code, inline code, images, and HTML markup are not prose. A Latin or Cyrillic word follows
 * Unicode word boundaries, so `don't` is one word and `state-of-the-art` is four. A Persian or Arabic word is a run
 * of Arabic-script letters, including the zero-width non-joiner (U+200C), so `می‌شود` and `کتاب‌ها` are one word
 * each. Han, Hiragana, Katakana, and Hangul have no spaces between words, so each code point counts as one word.
 */
export function countWords(markdown: string): number {
  const text = proseOf(markdown);
  let words = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) words += 1;
  }
  // CJK is counted per code point above; the remaining scripts use the segmenter's word boundaries.
  for (const part of WORDS.segment(text.replace(CJK_ALL, " "))) {
    if (part.isWordLike) words += 1;
  }
  return words;
}

/** The rate to use, accepting only a finite positive number and falling back to the documented default. */
function rateOf(options?: ReadingTimeOptions): number {
  const rate = options?.wordsPerMinute;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_WORDS_PER_MINUTE;
}

/** Reading time in whole minutes: `ceil(words / rate)`, so a page never rounds down to zero unless it has no words. */
export function minutesFor(words: number, options?: ReadingTimeOptions): number {
  return Math.ceil(words / rateOf(options));
}

/** One doc page's reading time, from its Markdown body. */
export function readingTimeOf(page: Page, options?: ReadingTimeOptions): ReadingTimePage {
  const words = countWords(page.markdown);
  return { url: page.url, words, minutes: minutesFor(words, options), source: page.source.file };
}

/**
 * Every doc page's reading time, sorted by URL. App and asset pages are skipped, since they are programs or files
 * rather than prose. The default rate is {@link DEFAULT_WORDS_PER_MINUTE}; a caller may override it through
 * {@link ReadingTimeOptions}.
 */
export function readingTimeForPages(pages: readonly Page[], options?: ReadingTimeOptions): readonly ReadingTimePage[] {
  return pages
    .filter((page) => page.kind === "doc")
    .map((page) => readingTimeOf(page, options))
    .sort((a, b) => byCodePoint(a.url, b.url));
}

/**
 * The `reading-time` fact: each doc page's word count and reading time, so a theme can read the same numbers during
 * render that the `reading-time` output writes. A site's `_data/reading-time.yml` wins over this value.
 */
export const readingTime: Fact = {
  name: "reading-time",
  compute({ pages }) {
    return readingTimeForPages(pages);
  },
};
