import { posix } from "node:path";
import { permalink } from "../content/permalink.ts";
import type { Page } from "../contracts/content.ts";

/** The weight of one query-term occurrence in each part of a page. */
export interface RankWeights {
  /** A term in the page title. */
  readonly title: number;
  /** A term in a heading's text. */
  readonly headings: number;
  /** A term in the page's rendered body, headings excluded. */
  readonly body: number;
  /** How much inbound links may raise a page that already matches the query. */
  readonly links: number;
}

/** The documented default weights: a title term is worth eight body terms, a heading term four. */
export const defaultRankWeights: RankWeights = Object.freeze({
  title: 8,
  headings: 4,
  body: 1,
  links: 0.5,
});

/** Options for {@link rankPages}. */
export interface RankOptions {
  /**
   * Site `base` from config: a path starting with `/` and without a trailing slash, or `""` at a
   * domain root. The model's page URLs include it, while links rewritten by the Markdown plugin do
   * not, so passing it lets both forms match exactly. Without it, a unique suffix match still
   * connects the two forms.
   */
  readonly base?: string;
  /** Weights to override; defaults are {@link defaultRankWeights}. */
  readonly weights?: Partial<RankWeights>;
}

/** One page and why it ranked where it did. */
export interface RankedPage {
  /** The page that was ranked. */
  readonly page: Page;
  /** Its relevance score; higher is better. Zero means no query term matched. */
  readonly score: number;
  /** The number of distinct other pages on this site that link to it. */
  readonly inboundLinks: number;
}

/** Function words that carry no topic, in the languages the engine's sites use. */
const STOPWORDS: readonly string[] = [
  // English
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
  "i", "in", "is", "it", "of", "on", "or", "our", "that", "the", "this", "to", "was", "we",
  "what", "when", "where", "which", "who", "why", "with", "you", "your",
  // Persian
  "آن", "از", "است", "این", "با", "بر", "برای", "به", "بود", "تا", "در", "را", "شد", "كه",
  "که", "می", "ها", "های", "هم", "و", "یا", "یک",
  // Arabic
  "أو", "إلى", "أن", "إن", "التي", "الذي", "ثم", "عن", "في", "قد", "كان", "كانت", "لا",
  "ما", "مع", "من", "هل", "هذا", "هذه", "و", "على", "ذلك",
];

/**
 * The Arabic/Persian letters that writers use interchangeably. The value is the Persian form the
 * ranker compares in, so `كتاب` and `کتاب`, or `ميرود` and `میرود`, are one term.
 */
const LETTER_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  "\u0622": "\u0627", // آ → ا
  "\u0623": "\u0627", // أ → ا
  "\u0625": "\u0627", // إ → ا
  "\u0624": "\u0648", // ؤ → و
  "\u0626": "\u06cc", // ئ → ی
  "\u0629": "\u0647", // ة → ه
  "\u0643": "\u06a9", // ك → ک
  "\u0649": "\u06cc", // ى → ی
  "\u064a": "\u06cc", // ي → ی
  "\u0671": "\u0627", // ٱ → ا
});

/** A single code point in a regular expression, so the variant table can drive one replacement. */
const LETTER_VARIANT = new RegExp(`[${Object.keys(LETTER_VARIANTS).join("")}]`, "g");

/** English and Arabic diacritics, and the Arabic tatweel that joins letters without a sound. */
const DIACRITICS = /[\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/g;

/** Zero-width characters, including the Persian ZWNJ that joins two parts of one word. */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

/** Letters (with combining marks) and digits form a token; punctuation, hyphens, and whitespace split. */
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

/** An HTML anchor's opening tag. */
const ANCHOR = /<a\b[^>]*>/gi;

/** The `href` attribute of an anchor tag. */
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** A Markdown inline link or image, including an optional title. */
const MD_LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** A Markdown reference definition, whose target links written as `[text][id]` use. */
const MD_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>]+)>|(\S+))/gm;

/** The origin used only to resolve relative URLs and percent-encode both sides the same way. */
const ORIGIN = "https://mizzen.invalid";

/** A scheme (`https:`, `mailto:`) or protocol-relative (`//`) URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** The named entities that can appear in generated attributes and text. */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Decodes the named and numeric character references the HTML and Markdown stages write. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (match, hex: string, decimal: string, named: string) => {
    if (named) return ENTITIES[named.toLowerCase()] ?? match;
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * Normalises text before tokenising. It applies NFC, removes Arabic diacritics, tatweel, and
 * zero-width characters (so `می‌رود` and `میرود` are one word), maps Arabic letter variants to
 * their Persian forms (`كتاب` to `کتاب`, `ميرود` to `میرود`), and lower-cases Latin letters.
 */
export function normalizeRankText(text: string): string {
  return text
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(DIACRITICS, "")
    .replace(LETTER_VARIANT, (letter) => LETTER_VARIANTS[letter] ?? letter)
    .toLowerCase();
}

/** Splits normalised text into words. */
export function tokenizeRankText(text: string): readonly string[] {
  return normalizeRankText(text).match(TOKEN) ?? [];
}

/** The stopwords, normalised through the same path as queries. */
const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS.flatMap((word) => tokenizeRankText(word)));

/** The distinct query terms, in first-seen order, with stopwords and duplicates removed. */
function queryTerms(query: string): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of tokenizeRankText(query)) {
    if (STOPWORD_SET.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Term frequencies of a field. */
function frequencies(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenizeRankText(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** The text of an HTML fragment, with script, style, comments, and headings removed. */
function textOfHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
      .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

/** The text of a Markdown body, with link syntax, fences, and definitions reduced to their words. */
function textOfMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}\[[^\]]+\]:.*$/gm, " ")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+])\s*/gm, " ");
}

/** The body text used for scoring: rendered HTML when there is some, else the Markdown source. */
function bodyText(page: Page): string {
  return page.html.trim() === "" ? textOfMarkdown(page.markdown) : textOfHtml(page.html);
}

/** Normalises a site `base` to `""` or `/docs`-shaped, without a trailing slash. */
function normalizeBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === "" || trimmed === "/") return "";
  return (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "");
}

/** Strips `base` from a path, along whole segments only. */
function stripBase(path: string, base: string): string {
  if (base === "") return path;
  if (path === base) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) || "/" : path;
}

/** A page-shaped path: `/guide/install/`, not `/guide/install` or `/guide/install/index.html`. */
function normalizePagePath(path: string): string {
  let value = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  value = value.replace(/\/index\.html?$/i, "/");
  const last = value.slice(value.lastIndexOf("/") + 1);
  if (last !== "" && !last.includes(".") && !value.endsWith("/")) value = `${value}/`;
  return value;
}

/** The comparable path of a page URL, with the site `base` removed. */
function keyOfUrl(url: string, base: string): string | undefined {
  try {
    return normalizePagePath(stripBase(new URL(url, ORIGIN).pathname, base));
  } catch {
    return undefined;
  }
}

/** The comparable path of an `href`, or undefined when it leaves the site or names only an anchor. */
function keyOfHref(href: string, fromUrl: string, base: string): string | undefined {
  const value = decodeEntities(href).trim();
  if (value === "" || value.startsWith("#") || EXTERNAL.test(value)) return undefined;
  try {
    const from = fromUrl.startsWith("/") ? fromUrl : `/${fromUrl}`;
    return normalizePagePath(stripBase(new URL(value, `${ORIGIN}${from}`).pathname, base));
  } catch {
    return undefined;
  }
}

/** Every `href` in an HTML fragment. */
function htmlHrefs(html: string): readonly string[] {
  const hrefs: string[] = [];
  for (const tag of html.match(ANCHOR) ?? []) {
    const match = HREF.exec(tag);
    if (match) hrefs.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return hrefs;
}

/** Every link target in a Markdown fragment, inline and reference-style. */
function markdownHrefs(markdown: string): readonly string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MD_LINK)) {
    const target = match[1] ?? "";
    hrefs.push(target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target);
  }
  for (const match of markdown.matchAll(MD_DEFINITION)) hrefs.push(match[1] ?? match[2] ?? "");
  return hrefs;
}

/** The path of a Markdown link, resolving a source `.md` target through {@link permalink}. */
function keyOfMarkdownHref(href: string, page: Page, base: string): string | undefined {
  const value = href.trim();
  if (value === "" || value.startsWith("#") || EXTERNAL.test(value)) return undefined;
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  if (!/\.(?:md|markdown|html?)$/i.test(path)) return keyOfHref(value, page.url, base);
  const source = path.startsWith("/")
    ? path.slice(1)
    : posix.normalize(posix.join(posix.dirname(page.source.file.replace(/\\/g, "/")), path));
  return keyOfUrl(permalink(source, { base }), base);
}

/** The distinct pages a page links to, from its rewritten HTML and, when present, its Markdown source. */
function outboundKeys(page: Page, base: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const href of htmlHrefs(page.html)) {
    const key = keyOfHref(href, page.url, base);
    if (key !== undefined) keys.add(key);
  }
  for (const href of markdownHrefs(page.markdown)) {
    const key = keyOfMarkdownHref(href, page, base);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * Finds the page a link path names. An exact match wins; otherwise a unique suffix match connects a
 * link written without `base` (the Markdown plugin's form) or with a source prefix to the page's
 * URL. An ambiguous suffix names no page, so the link counts for nothing rather than for everyone.
 */
function pageOfKey(key: string, keys: readonly string[], pages: ReadonlyMap<string, Page>): Page | undefined {
  const exact = pages.get(key);
  if (exact !== undefined) return exact;
  if (key === "/") return undefined;
  const matches = keys.filter((candidate) => candidate === key || candidate.endsWith(key) || key.endsWith(candidate));
  return matches.length === 1 ? pages.get(matches[0]!) : undefined;
}

/** Resolves the weights, ignoring invalid overrides rather than letting them break the order. */
function resolveWeights(weights: Partial<RankWeights> | undefined): RankWeights {
  const resolved: Record<keyof RankWeights, number> = { ...defaultRankWeights };
  if (weights !== undefined) {
    for (const key of Object.keys(resolved) as (keyof RankWeights)[]) {
      const value = weights[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Ranks pages for a query without a network call or a model.
 *
 * Each distinct query term scores once per occurrence in the title, the heading texts, and the
 * body (the rendered HTML without its headings), with the weights in {@link defaultRankWeights}.
 * A page's score is then multiplied by `1 + links × inbound / maxInbound`, where `inbound` is the
 * number of distinct other pages whose internal links point at it. A page that matches no term
 * keeps a score of zero however many links it has.
 *
 * Text is tokenised after {@link normalizeRankText}: Persian and Arabic letter variants, Arabic
 * diacritics, tatweel, and zero-width characters (including ZWNJ) do not split a word, and Latin
 * letters are case-folded. Query stopwords in English, Persian, and Arabic are dropped; an empty
 * or stopword-only query returns every page with score zero. Duplicate query terms count once.
 *
 * Internal links come from `page.html` (already rewritten to page URLs) and from `page.markdown`
 * (resolved through {@link permalink}), so a page without rendered HTML still contributes its
 * links. Self-links are ignored, links from one page to the same target count once, and a link
 * counts only when it names exactly one page.
 *
 * The order is deterministic: score descending, then URL by code point. Pages are not mutated.
 */
export function rankPages(pages: readonly Page[], query: string, options: RankOptions = {}): readonly RankedPage[] {
  const base = normalizeBase(options.base ?? "");
  const weights = resolveWeights(options.weights);
  const terms = queryTerms(query);

  const keys: string[] = [];
  const byKey = new Map<string, Page>();
  for (const page of pages) {
    const key = keyOfUrl(page.url, base);
    if (key === undefined || byKey.has(key)) continue;
    keys.push(key);
    byKey.set(key, page);
  }

  const inbound = new Map<string, number>();
  for (const page of pages) {
    const from = keyOfUrl(page.url, base);
    if (from === undefined) continue;
    const targets = new Set<string>();
    for (const target of outboundKeys(page, base)) {
      const linked = pageOfKey(target, keys, byKey);
      const to = linked === undefined ? undefined : keyOfUrl(linked.url, base);
      if (to === undefined || to === from) continue;
      targets.add(to);
    }
    for (const target of targets) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  }

  let maxInbound = 0;
  for (const count of inbound.values()) if (count > maxInbound) maxInbound = count;

  const ranked = pages.map((page): RankedPage => {
    const title = frequencies(page.title);
    const headings = frequencies(page.headings.map((heading) => heading.text).join(" "));
    const body = frequencies(bodyText(page));
    let relevance = 0;
    for (const term of terms) {
      relevance += weights.title * (title.get(term) ?? 0);
      relevance += weights.headings * (headings.get(term) ?? 0);
      relevance += weights.body * (body.get(term) ?? 0);
    }
    const key = keyOfUrl(page.url, base);
    const inboundLinks = key === undefined ? 0 : inbound.get(key) ?? 0;
    const centrality = maxInbound === 0 ? 0 : inboundLinks / maxInbound;
    return { page, score: relevance * (1 + weights.links * centrality), inboundLinks };
  });

  return ranked.sort((a, b) => b.score - a.score || byCodePoint(a.page.url, b.page.url));
}
