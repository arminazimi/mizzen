import { posix } from "node:path";
import { discoverVersions, type VersionOptions } from "../content/versions.ts";
import { permalink } from "../content/permalink.ts";
import type { Page, PageStatus } from "../contracts/content.ts";

/**
 * The weight of one query-term occurrence in each part of a page, and of each task signal relative
 * to a page's lexical relevance.
 */
export interface RankWeights {
  /** A term in the page title. */
  readonly title: number;
  /** A term in a heading's text. */
  readonly headings: number;
  /** A term in the page's rendered body, headings excluded. */
  readonly body: number;
  /** How much inbound links may raise a page that already matches the query. */
  readonly links: number;
  /** How much a page close to the task focus gains, per unit of proximity. */
  readonly navigation: number;
  /** How much a page in the requested (or newest) version gains, and one in another version loses. */
  readonly version: number;
  /** How much a page in the requested language gains, and one in another language loses. */
  readonly locale: number;
  /** The most a page loses for low-trust evidence: a weak status, a generated body, or duplication. */
  readonly trust: number;
  /** How much a page gains for being required by a page the query matches. */
  readonly dependency: number;
}

/**
 * The documented default weights: a title term is worth eight body terms, a heading term four. The
 * task signals are fractions of a page's lexical relevance; by default the three that can demote a
 * page (`version`, `locale`, `trust`) add up to less than one, so a matching page never scores
 * below zero.
 */
export const defaultRankWeights: RankWeights = Object.freeze({
  title: 8,
  headings: 4,
  body: 1,
  links: 0.5,
  navigation: 0.35,
  version: 0.25,
  locale: 0.15,
  trust: 0.5,
  dependency: 0.4,
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
  /** URL or source path of the page the task starts from; pages near it gain navigation proximity. */
  readonly focus?: string;
  /** BCP 47 language tag the task asks for; pages in it outrank pages in another language. */
  readonly lang?: string;
  /** Version folder the task asks for, such as `v2`; the newest detected version is the default. */
  readonly version?: string;
  /** How version folders are detected; see {@link discoverVersions}. */
  readonly versionOptions?: VersionOptions;
}

/** The signal that contributed to a page's score. */
export type RankFactor = "lexical" | "links" | "navigation" | "version" | "locale" | "trust" | "dependency";

/**
 * One machine-readable selection reason: a factor, the evidence that produced it, and what it added
 * to the score. A negative contribution demotes a page; `0` records evidence that did not change the
 * score, such as a page being the canonical member of a duplicate group.
 */
export interface RankReason {
  /** Which signal produced this contribution. */
  readonly factor: RankFactor;
  /**
   * Stable evidence for the contribution: `title:<term>`, `headings:<term>`, `body:<term>`,
   * `inbound:<count>`, `focus:<url>`, `version:<name>`, `locale:<tag>`, `status:<value>`, `generated`,
   * `duplicate:<canonical url>`, `canonical`, or `dependency:<url>`.
   */
  readonly code: string;
  /** The amount this reason added to {@link RankedPage.score}; negative when it demoted the page. */
  readonly contribution: number;
}

/** One page and why it ranked where it did. */
export interface RankedPage {
  /** The page that was ranked. */
  readonly page: Page;
  /**
   * Its relevance score; higher is better. It is the sum of {@link reasons}. A page that matches no
   * query term scores zero unless a matching page depends on it.
   */
  readonly score: number;
  /** The number of distinct other pages on this site that link to it. */
  readonly inboundLinks: number;
  /**
   * The factor contributions that produced {@link score}, in a stable order. Empty when the page
   * matched no term and no matching page depends on it, so it is not selected.
   */
  readonly reasons: readonly RankReason[];
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

/** Compares by code point, never by locale. */
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

/** A language tag in the form matching compares: trimmed, lower case, `_` read as `-`. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** The non-empty segments of a page path. */
function keySegments(key: string): readonly string[] {
  return key.split("/").filter((segment) => segment !== "");
}

/**
 * How close a page is to the focus page, from 0 to 1: the shared leading URL segments over the
 * focus page's depth. Navigation folders mirror URLs, so a sibling scores a half and a page in
 * another section scores zero.
 */
function proximityOf(key: string, focusKey: string): number {
  const page = keySegments(key);
  const focus = keySegments(focusKey);
  if (focus.length === 0) return 0;
  let shared = 0;
  while (shared < page.length && shared < focus.length && page[shared] === focus[shared]) shared++;
  return shared / focus.length;
}

/** The page a focus URL or source path names; an absent or ambiguous focus names no page. */
function resolveFocus(pages: readonly Page[], focus: string, base: string): Page | undefined {
  const wanted = focus.trim();
  if (wanted === "") return undefined;
  const urlKey = keyOfUrl(wanted, base);
  if (urlKey !== undefined) {
    const byUrl = pages.filter((page) => keyOfUrl(page.url, base) === urlKey);
    if (byUrl.length === 1) return byUrl[0];
  }
  const source = wanted.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const bySource = pages.filter((page) => page.source.file.replace(/\\/g, "/").replace(/^\.\//, "") === source);
  return bySource.length === 1 ? bySource[0] : undefined;
}

/** The `translation_key` a page declares, or undefined when it declares none. */
function translationKeyOf(page: Page): string | undefined {
  const key = page.frontMatter.translation_key;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

/** How much a status lowers trust, as a fraction of the trust weight; `0` for a settled status. */
const STATUS_TRUST: Readonly<Record<PageStatus, number>> = Object.freeze({
  accepted: 0,
  experimental: 0.5,
  beta: 0.5,
  proposed: 0.5,
  deprecated: 1,
  rejected: 1,
  superseded: 1,
});

/** One reason a page is less trustworthy, as a fraction of the trust weight. */
interface TrustEvidence {
  readonly code: string;
  readonly fraction: number;
}

/** The trust evidence a page carries: a weak status, a generated body, or duplication. */
function trustEvidenceOf(page: Page, duplicateOf: ReadonlyMap<Page, string>): readonly TrustEvidence[] {
  const evidence: TrustEvidence[] = [];
  const status = page.frontMatter.status;
  const statusFraction = status === undefined ? 0 : STATUS_TRUST[status];
  if (statusFraction > 0) evidence.push({ code: `status:${status}`, fraction: statusFraction });
  if (page.frontMatter.agent?.edit === false) evidence.push({ code: "generated", fraction: 1 });
  const canonicalUrl = duplicateOf.get(page);
  if (canonicalUrl !== undefined) evidence.push({ code: `duplicate:${canonicalUrl}`, fraction: 1 });
  return evidence;
}

/** A group of pages that represent one document, and the predicate that marks its canonical member. */
interface DuplicateGroup {
  readonly members: readonly Page[];
  readonly preferred: (page: Page) => boolean;
}

/** Groups pages that represent the same document across versions or declared translations. */
function duplicateGroups(
  pages: readonly Page[],
  versions: ReadonlyMap<Page, { readonly version: string | null; readonly path: string }>,
  canonicalVersion: string | undefined,
  lang: string | undefined,
): readonly DuplicateGroup[] {
  const byVersion = new Map<string, Page[]>();
  const byTranslation = new Map<string, Page[]>();
  for (const page of pages) {
    const info = versions.get(page);
    if (info !== undefined && info.version !== null) {
      const group = byVersion.get(info.path);
      if (group === undefined) byVersion.set(info.path, [page]);
      else group.push(page);
    }
    const translation = lang === undefined ? undefined : translationKeyOf(page);
    if (translation !== undefined) {
      const group = byTranslation.get(translation);
      if (group === undefined) byTranslation.set(translation, [page]);
      else group.push(page);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const members of byVersion.values()) {
    if (members.length < 2) continue;
    groups.push({
      members,
      preferred: (page) => versions.get(page)?.version === canonicalVersion,
    });
  }
  for (const members of byTranslation.values()) {
    if (members.length < 2) continue;
    groups.push({ members, preferred: (page) => normalizeTag(page.lang) === lang });
  }
  return groups;
}

/**
 * Ranks pages for a query without a network call or a model.
 *
 * Each distinct query term scores once per occurrence in the title, the heading texts, and the
 * body (the rendered HTML without its headings), with the weights in {@link defaultRankWeights}.
 * That lexical relevance is then adjusted by task signals, each of which is a fraction of it:
 *
 * - **Links**: `links × inbound / maxInbound`, where `inbound` is the number of distinct other
 *   pages whose internal links point at it.
 * - **Navigation**: how close the page is to `focus` in the URL hierarchy, which mirrors the
 *   navigation folders. A sibling of the focus page scores a half.
 * - **Version**: a page in `version` — or in the newest detected version when none is named — gains
 *   `version`, and a page in another version loses as much. A site without version folders is
 *   unaffected.
 * - **Locale**: a page in `lang` gains `locale`, and a page in another language loses as much.
 * - **Trust**: a deprecated, rejected, or superseded page, a generated page (`agent.edit: false`),
 *   or a duplicate loses at most the `trust` weight. The duplicate loss names the canonical page in
 *   its reason, and the canonical page gets a zero-contribution `canonical` reason, so a duplicate
 *   never displaces its canonical source silently.
 * - **Dependency**: a page that a matching page links to and that matches no query term gains
 *   `dependency ×` the strongest linking page's relevance. This keeps required supporting pages
 *   (a requirements page, say) next to the primary source the task names.
 *
 * Duplicates are versioned pages with the same path inside their version, and pages sharing a
 * non-empty `translation_key` when `lang` is requested; the canonical member is the one in the
 * requested version or language, else the lowest URL. The order is deterministic: score descending,
 * then URL, then source file by code point. Equivalent inputs give an identical ranking and
 * identical reasons, and pages are not mutated.
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
 */
export function rankPages(pages: readonly Page[], query: string, options: RankOptions = {}): readonly RankedPage[] {
  const base = normalizeBase(options.base ?? "");
  const weights = resolveWeights(options.weights);
  const terms = queryTerms(query);
  const requestedLang = options.lang === undefined ? undefined : normalizeTag(options.lang);
  const requestedVersion = options.version?.trim();

  const keys: string[] = [];
  const byKey = new Map<string, Page>();
  for (const page of pages) {
    const key = keyOfUrl(page.url, base);
    if (key === undefined || byKey.has(key)) continue;
    keys.push(key);
    byKey.set(key, page);
  }

  const versionByPage = new Map<Page, { readonly version: string | null; readonly path: string }>();
  let newestVersion: string | undefined;
  for (const entry of discoverVersions(pages, options.versionOptions)) {
    versionByPage.set(entry.page, { version: entry.version, path: entry.path });
    if (entry.version !== null) newestVersion = entry.version;
  }
  const knownVersion =
    requestedVersion !== undefined && [...versionByPage.values()].some((info) => info.version === requestedVersion);
  const canonicalVersion = knownVersion ? requestedVersion : newestVersion;

  const focusPage = options.focus === undefined ? undefined : resolveFocus(pages, options.focus, base);
  const focusKey = focusPage === undefined ? undefined : keyOfUrl(focusPage.url, base);

  const outbound = new Map<string, { readonly url: string; readonly targets: ReadonlySet<string> }>();
  for (const page of pages) {
    const from = keyOfUrl(page.url, base);
    if (from === undefined || outbound.has(from)) continue;
    const targets = new Set<string>();
    for (const target of outboundKeys(page, base)) {
      const linked = pageOfKey(target, keys, byKey);
      const to = linked === undefined ? undefined : keyOfUrl(linked.url, base);
      if (to !== undefined && to !== from) targets.add(to);
    }
    outbound.set(from, { url: page.url, targets });
  }

  const inbound = new Map<string, number>();
  for (const links of outbound.values()) {
    for (const target of links.targets) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  }
  let maxInbound = 0;
  for (const count of inbound.values()) if (count > maxInbound) maxInbound = count;

  const lexical = new Map<Page, { readonly relevance: number; readonly reasons: readonly RankReason[] }>();
  for (const page of pages) {
    const title = frequencies(page.title);
    const headings = frequencies(page.headings.map((heading) => heading.text).join(" "));
    const body = frequencies(bodyText(page));
    const reasons: RankReason[] = [];
    let relevance = 0;
    for (const term of terms) {
      const titleCount = title.get(term) ?? 0;
      if (titleCount > 0) {
        const contribution = weights.title * titleCount;
        relevance += contribution;
        reasons.push({ factor: "lexical", code: `title:${term}`, contribution });
      }
      const headingCount = headings.get(term) ?? 0;
      if (headingCount > 0) {
        const contribution = weights.headings * headingCount;
        relevance += contribution;
        reasons.push({ factor: "lexical", code: `headings:${term}`, contribution });
      }
      const bodyCount = body.get(term) ?? 0;
      if (bodyCount > 0) {
        const contribution = weights.body * bodyCount;
        relevance += contribution;
        reasons.push({ factor: "lexical", code: `body:${term}`, contribution });
      }
    }
    lexical.set(page, { relevance, reasons });
  }

  const relevanceByKey = new Map<string, number>();
  for (const page of pages) {
    const key = keyOfUrl(page.url, base);
    const relevance = lexical.get(page)?.relevance ?? 0;
    if (key !== undefined && relevance > (relevanceByKey.get(key) ?? 0)) relevanceByKey.set(key, relevance);
  }

  const dependency = new Map<string, { readonly from: string; readonly relevance: number }>();
  for (const [from, links] of outbound) {
    const relevance = relevanceByKey.get(from) ?? 0;
    if (relevance <= 0) continue;
    for (const target of links.targets) {
      if ((relevanceByKey.get(target) ?? 0) > 0) continue;
      const current = dependency.get(target);
      const better =
        current === undefined ||
        relevance > current.relevance ||
        (relevance === current.relevance && byCodePoint(links.url, current.from) < 0);
      if (better) dependency.set(target, { from: links.url, relevance });
    }
  }

  const duplicateOf = new Map<Page, string>();
  const canonical = new Set<Page>();
  for (const group of duplicateGroups(pages, versionByPage, canonicalVersion, requestedLang)) {
    const preferred = group.members.filter(group.preferred);
    const pool = preferred.length > 0 ? preferred : group.members;
    const first = [...pool].sort((a, b) => byCodePoint(a.url, b.url))[0];
    if (first === undefined) continue;
    canonical.add(first);
    for (const member of group.members) {
      if (member === first) continue;
      const existing = duplicateOf.get(member);
      // A page can be non-canonical in both a version and a translation group; keep one stable name.
      if (existing === undefined || byCodePoint(first.url, existing) < 0) duplicateOf.set(member, first.url);
    }
  }

  const ranked = pages.map((page): RankedPage => {
    const key = keyOfUrl(page.url, base);
    const entry = lexical.get(page);
    const relevance = entry?.relevance ?? 0;
    const reasons: RankReason[] = [...(entry?.reasons ?? [])];
    const inboundLinks = key === undefined ? 0 : inbound.get(key) ?? 0;

    if (relevance > 0 && inboundLinks > 0 && maxInbound > 0) {
      reasons.push({
        factor: "links",
        code: `inbound:${inboundLinks}`,
        contribution: relevance * weights.links * (inboundLinks / maxInbound),
      });
    }

    if (relevance > 0 && focusPage !== undefined && focusKey !== undefined && key !== undefined) {
      const proximity = proximityOf(key, focusKey);
      if (proximity > 0) {
        reasons.push({
          factor: "navigation",
          code: `focus:${focusPage.url}`,
          contribution: relevance * weights.navigation * proximity,
        });
      }
    }

    const versionInfo = versionByPage.get(page);
    if (relevance > 0 && versionInfo !== undefined && versionInfo.version !== null && canonicalVersion !== undefined) {
      const sign = versionInfo.version === canonicalVersion ? 1 : -1;
      reasons.push({
        factor: "version",
        code: `version:${versionInfo.version}`,
        contribution: relevance * weights.version * sign,
      });
    }

    if (relevance > 0 && requestedLang !== undefined) {
      const pageLang = normalizeTag(page.lang);
      const sign = pageLang === requestedLang ? 1 : -1;
      reasons.push({
        factor: "locale",
        code: `locale:${pageLang}`,
        contribution: relevance * weights.locale * sign,
      });
    }

    if (relevance > 0) {
      const evidence = trustEvidenceOf(page, duplicateOf);
      let total = 0;
      for (const item of evidence) total += item.fraction;
      const capped = Math.min(1, total);
      for (const item of evidence) {
        reasons.push({
          factor: "trust",
          code: item.code,
          contribution: -(weights.trust * relevance * capped * item.fraction) / total,
        });
      }
      if (canonical.has(page)) reasons.push({ factor: "trust", code: "canonical", contribution: 0 });
    }

    const required = key === undefined ? undefined : dependency.get(key);
    if (relevance === 0 && required !== undefined) {
      reasons.push({
        factor: "dependency",
        code: `dependency:${required.from}`,
        contribution: required.relevance * weights.dependency,
      });
    }

    let score = 0;
    for (const reason of reasons) score += reason.contribution;
    return { page, score, inboundLinks, reasons };
  });

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      byCodePoint(a.page.url, b.page.url) ||
      byCodePoint(a.page.source.file, b.page.source.file),
  );
}
