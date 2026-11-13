/**
 * Compiles a validated {@link ContextRequest} into the same {@link PackEvidence} model the build's
 * `context-pack` output writes, plus its Markdown pack.
 *
 * This is the one adapter between the request contract and the pack pipeline. It applies, in order:
 *
 * - **Task intent**: `task.goal` is the ranking query. `task.kind` is preserved by the parser for the
 *   rank profiles a later step adds; this compiler never invents one.
 * - **Measured trust**: one snapshot of the pack's own build is taken before ranking. Each trust entry is
 *   projected into the ranker's example, drift, review-age, and coverage inputs — a signal the entry does
 *   not measure stays unmeasured there — and the same snapshot is what each selected item publishes as its
 *   `trust`, so an item's evidence and its rank reasons always describe one build.
 * - **Candidate hints**: an `include` hint that names a page (URL, source path, or section id) pins that
 *   page ahead of the ranking; a hint that names a topic (plain words) joins the query. An `exclude`
 *   hint removes matching pages before ranking, and can never be overridden by required evidence.
 * - **Constraints**: `locale` limits candidates to that language (and its more specific tags), `exact`
 *   keeps one version folder, and `min`/`max` keep that inclusive range. Pages outside every version
 *   folder are current docs and are kept unless `exact` asks for one folder.
 * - **Budget**: `maxTokens` minus `reservedTokens` is what optional content may spend; required evidence
 *   is priced before it and never dropped. Final acceptance and page removal read the estimator's upper
 *   bound of the exact Markdown, the pack title, headers, and separators included, so a pack that is not
 *   diagnosed as over budget satisfies `accounting.upper <= budget`. A page's mandatory lead is always
 *   kept, as in `trimPages`.
 * - **Required evidence**: a `refs` entry pins the page it names (by URL, source path, section id, or
 *   heading text) and is passed to `trimPages` as a pinned section. The `source`, `versions`, `warnings`,
 *   and `dependencies` flags add machine-readable lines to each selected item, so the Markdown pack and
 *   its JSON twin carry the same evidence.
 *
 * The output is deterministic: no clock, network, environment, or absolute path reaches either form.
 * The build identity uses the same rule as `src/outputs/context-pack.ts`, and a request needs neither a
 * theme nor `_data/context-packs.yml`.
 */
import { posix } from "node:path";
import type { ContextRequest } from "../contracts/context-request.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { OutputContext } from "../contracts/output.ts";
import type { SourcePos } from "../contracts/source.ts";
import { discoverVersions } from "../content/versions.ts";
import { version } from "../index.ts";
import { buildHashOf, hashOf } from "../outputs/build-hash.ts";
import {
  coverageOf,
  warningOf,
  type PackAccounting,
  type PackBuild,
  type PackEvidence,
  type PackItem,
  type PackOmission,
  type PackPageOmission,
  type PackSection,
  type PackSelection,
} from "../outputs/context-pack.ts";
import { trustReport, type TrustEntry, type TrustEntryFactor, type TrustPageEntry } from "../outputs/trust.ts";
import { blockIdOf, formatSpan } from "../source/spans.ts";
import {
  rankPages,
  type RankTrustEvidence,
  type RankTrustPage,
  type RankedPage,
} from "./rank.ts";
import { estimateTokens } from "./tokens.ts";
import { trimPages, type RequiredEvidence, type TrimResult } from "./trim.ts";

/** A URL base for resolving links and page addresses without reading a clock or environment. */
const ORIGIN = "https://mizzen.invalid";

/** A scheme (`https:`, `mailto:`) or a protocol-relative URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** Inline and image Markdown links. */
const MD_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/** Reference-style Markdown link definitions. */
const MD_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(\S+)/gm;

/** An `href` in rendered HTML. */
const ANCHOR_HREF = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** One selected page's required evidence, in the order the pack shows it. */
interface PageEvidence {
  /** The exact lines added to the page's content, in both outputs. */
  readonly lines: readonly string[];
  /** The same lines as required trim evidence, so the budget prices them first. */
  readonly required: readonly RequiredEvidence[];
}

/** Options of {@link compilePack}. */
export interface CompileOptions {
  /** The model's findings, so `requiredEvidence.warnings` can keep the warnings attached to selected pages. */
  readonly warnings?: readonly Diagnostic[];
  /** Trust entries to reuse, by URL; computed from the site's data when absent. */
  readonly trust?: ReadonlyMap<string, TrustEntry>;
  /**
   * The identity of the build {@link CompileOptions.trust} was measured in. Absent means the pack's own
   * build, so the evidence ranks and publishes; any other value means another build's evidence, which
   * raises no page and is published nowhere.
   */
  readonly trustBuild?: string;
}

/** One page's entry in a trust snapshot: the published entry and the rank projection measured from it. */
interface SnapshotPage {
  /** The entry the pack publishes as the item's `trust`. */
  readonly trust: TrustEntry;
  /** The same signals as the ranker's example, drift, review-age, and coverage inputs. */
  readonly evidence: RankTrustPage;
}

/**
 * The trust evidence of one build, in the two forms the compiler needs: {@link rankPages} reads the
 * projection with the pack's own build identity, and the pack publishes the entries projected from it,
 * so an item's evidence and its rank reasons can never name different measurements.
 */
interface TrustSnapshot {
  /** The identity the entries were measured in, as the ranker's `trust.build`. */
  readonly build: string;
  /** Whether those entries belong to the build being packed; another build's entries are read by neither. */
  readonly applies: boolean;
  /** The projection the ranker reads, keyed by page URL, with {@link TrustSnapshot.build} as its build. */
  readonly evidence: RankTrustEvidence;
  /** One page's entry and projection, by page URL. */
  readonly pages: ReadonlyMap<string, SnapshotPage>;
}

/** One compiled pack: the Markdown a person pastes, and the structured evidence a tool reads. */
export interface CompiledPack {
  /** The Markdown pack. */
  readonly markdown: string;
  /** The structured twin, the same shape `pack/<slug>.json` has. */
  readonly evidence: PackEvidence;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapses every run of whitespace to one space, so a value never breaks a line of the pack. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A page's source path with forward slashes, as the pack shows it. */
function sourceOf(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/** The URL the pack shows for a page: absolute when the config has `url`, else the site-relative URL. */
function absoluteUrl(url: string, site: Site): string {
  const origin = site.config.url?.replace(/\/+$/, "");
  return origin === undefined || origin === "" ? url : `${origin}${url}`;
}

/** A page's URL without the site `base`, for matching entries written as site paths. */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** Whether a hint names this page by URL (with or without `base` and a trailing slash) or exact source path. */
function matchesPage(page: Page, reference: string, base: string): boolean {
  const value = reference.trim().replace(/\\/g, "/");
  if (value === "") return false;

  const url = value.startsWith("/") ? value : `/${value}`;
  const candidate = url.length > 1 ? url.replace(/\/+$/, "") : url;
  for (const pageUrl of [page.url, underBase(page.url, base)]) {
    const comparable = pageUrl.length > 1 ? pageUrl.replace(/\/+$/, "") : pageUrl;
    if (comparable === candidate) return true;
  }

  const source = value.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "");
  return source !== "" && sourceOf(page) === source;
}

/** The source file a positional section reference names, such as `guide/install.md:9:1`, or `undefined`. */
function sectionRefPath(reference: string): string | undefined {
  const value = reference.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(?:\.\/)+/, "");
  const match = /^(.+):\d+(?::\d+)?$/.exec(value);
  return match?.[1];
}

/** Whether a hint names this page itself or a section inside it; a section ref must be pinned to its page. */
function namesPage(page: Page, reference: string, base: string): boolean {
  return matchesPage(page, reference, base) || sectionRefPath(reference) === sourceOf(page);
}

/** Whether a hint with no URL or source shape names the page's topic by title or heading. */
function matchesTopic(page: Page, hint: string): boolean {
  const term = oneLine(hint).toLowerCase();
  if (term === "" || /[\\/.#:]/.test(term)) return false;
  return (
    oneLine(page.title).toLowerCase().includes(term) ||
    page.headings.some((heading) => oneLine(heading.text).toLowerCase().includes(term))
  );
}

/** The pages in `pages` a hint names, in page order. */
function pagesNamed(pages: readonly Page[], hint: string, base: string): readonly Page[] {
  return pages.filter((page) => namesPage(page, hint, base) || matchesTopic(page, hint));
}

/** The numeric parts of a `vN`, `vN.M`, or `vN.M.P` version folder. */
function versionNumbers(name: string): readonly [number, number, number] {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(name);
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0), Number(match?.[3] ?? 0)];
}

/** Compares two version folders by their numeric parts. */
function compareVersions(a: string, b: string): number {
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether a page's version folder is allowed by the request's range. */
function versionAllowed(pageVersion: string | null, range: ContextRequest["constraints"]["version"]): boolean {
  if (range === undefined) return true;
  if (range.exact !== undefined) return pageVersion === range.exact;
  if (pageVersion === null) return true;
  if (range.min !== undefined && compareVersions(pageVersion, range.min) < 0) return false;
  if (range.max !== undefined && compareVersions(pageVersion, range.max) > 0) return false;
  return true;
}

/** A language tag in the form matching compares: trimmed, lower case, `_` read as `-`. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** Whether a page's language satisfies a requested locale, allowing a more specific or more general tag. */
function localeAllowed(pageLang: string, locale: string | undefined): boolean {
  if (locale === undefined) return true;
  const page = normalizeTag(pageLang);
  const request = normalizeTag(locale);
  return page === request || page.startsWith(`${request}-`) || request.startsWith(`${page}-`);
}

/** The documentation version folder of each page, by page; `null` when the page is outside every version. */
function pageVersionsOf(site: Site): ReadonlyMap<Page, string | null> {
  const versions = new Map<Page, string | null>();
  for (const entry of discoverVersions(site.pages)) versions.set(entry.page, entry.version);
  return versions;
}

/** The documentation build a pack was compiled from: engine version plus a hash over every doc page. */
function buildIdentityOf(site: Site): PackBuild {
  const sources: Record<string, string> = {};
  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    const key = page.url.replace(/^\/+|\/+$/g, "") || "index";
    sources[key] = hashOf(`${absoluteUrl(page.url, site)}\0${hashOf(page.markdown)}`);
  }
  return { engine: version, id: buildHashOf(sources) };
}

/** The trust fields of one `trust.json` page entry, without the join facts the pack already carries. */
function trustEntryOf(entry: TrustPageEntry): TrustEntry {
  return {
    evidence: entry.evidence,
    level: entry.level,
    factors: entry.factors,
    reviewCoverage: entry.reviewCoverage,
    reasons: entry.reasons,
    ...(entry.lastReviewer === undefined ? {} : { lastReviewer: entry.lastReviewer }),
  };
}

/** A measured whole, non-negative count; a fractional, negative, or non-numeric value measured nothing. */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The entry's factor of one signal, in the fixed examples-drift-review order, or `undefined` when absent. */
function factorOf(
  entry: TrustEntry,
  signal: TrustEntryFactor["signal"],
): TrustEntryFactor | undefined {
  return entry.factors?.find((factor) => factor.signal === signal);
}

/**
 * The example evidence as the ranker reads it. A trust entry names the failing count, not the totals, so
 * the projection gives the smallest count set the entry supports: `k` failures of `k`, or one passing
 * example of one. A conflict, an unknown result, or a factor the entry does not carry projects to
 * `"unknown"`, which the ranker reads as unmeasured rather than clean.
 */
function examplesEvidence(entry: TrustEntry): RankTrustPage["examples"] {
  if (entry.evidence.examples === "none") return "none";
  if (entry.evidence.examples !== "measured") return "unknown";
  const factor = factorOf(entry, "examples");
  switch (factor?.code) {
    case "examples.none":
      return "none";
    case "examples.passed":
      return { total: 1, passed: 1, failed: 0 };
    case "examples.failed": {
      const failed = countOf(factor.value);
      return failed === undefined || failed === 0 ? "unknown" : { total: failed, passed: 0, failed };
    }
    default:
      return "unknown";
  }
}

/**
 * The drift evidence as the ranker reads it: a clean count, the measured finding count, `"unknown"` for
 * an unreadable or contradicted count, and nothing for a page whose drift was never checked.
 */
function driftEvidence(entry: TrustEntry): RankTrustPage["drift"] {
  if (entry.evidence.drift !== "measured") return entry.evidence.drift === "missing" ? undefined : "unknown";
  const factor = factorOf(entry, "drift");
  if (factor?.code === "drift.clean") return 0;
  if (factor?.code === "drift.findings") {
    const findings = countOf(factor.value);
    return findings === undefined || findings === 0 ? "unknown" : findings;
  }
  return "unknown";
}

/** The whole days since the page was last reviewed, as the ranker reads them. */
function reviewEvidence(entry: TrustEntry): RankTrustPage["reviewAgeDays"] {
  if (entry.evidence.review !== "measured") return entry.evidence.review === "missing" ? undefined : "unknown";
  const factor = factorOf(entry, "review");
  if (factor?.code !== "review.recent" && factor?.code !== "review.overdue") return "unknown";
  return countOf(factor.value);
}

/** What the review source knows, or `undefined` when the entry names no coverage at all. */
function coverageEvidence(entry: TrustEntry): RankTrustPage["reviewCoverage"] {
  const coverage = entry.reviewCoverage;
  return coverage === undefined ||
    coverage === "recorded" ||
    coverage === "untracked" ||
    coverage === "unavailable" ||
    coverage === "unknown"
    ? coverage
    : "unknown";
}

/** One entry's measured signals, as the ranker's evidence for one page. */
function evidenceOfEntry(entry: TrustEntry): RankTrustPage {
  const examples = examplesEvidence(entry);
  const drift = driftEvidence(entry);
  const reviewAgeDays = reviewEvidence(entry);
  const reviewCoverage = coverageEvidence(entry);
  return {
    ...(examples === undefined ? {} : { examples }),
    ...(drift === undefined ? {} : { drift }),
    ...(reviewAgeDays === undefined ? {} : { reviewAgeDays }),
    ...(reviewCoverage === undefined ? {} : { reviewCoverage }),
  };
}

/**
 * The snapshot of {@link CompileOptions.trust} for the build being packed, keyed by page URL and stamped
 * with the build the entries name (`measuredIn`, or this pack's own build when the caller does not know
 * better). The evidence record is written in URL order, so entry order never reaches the ranking.
 */
function trustSnapshotOf(
  build: string,
  trust: ReadonlyMap<string, TrustEntry>,
  measuredIn: string | undefined,
): TrustSnapshot {
  const stamp = (measuredIn ?? build).trim();
  const pages = new Map<string, SnapshotPage>();
  for (const url of [...trust.keys()].sort(byCodePoint)) {
    const entry = trust.get(url);
    if (entry === undefined) continue;
    pages.set(url, { trust: entry, evidence: evidenceOfEntry(entry) });
  }
  const record: Record<string, RankTrustPage> = {};
  for (const [url, measured] of pages) record[url] = measured.evidence;
  return {
    build: stamp,
    applies: stamp !== "" && stamp === build.trim(),
    evidence: { build: stamp, pages: record },
    pages,
  };
}

/** The trust entry of every doc page, by URL, from the same signals and thresholds as `trust.json`. */
async function trustIndexOf(site: Site): Promise<ReadonlyMap<string, TrustEntry>> {
  const [file] = await trustReport(site);
  if (file === undefined) return new Map();
  const report = JSON.parse(String(file.contents)) as {
    readonly pages: Readonly<Record<string, TrustPageEntry>>;
  };
  return new Map(Object.values(report.pages).map((entry) => [entry.url, trustEntryOf(entry)]));
}

/** A section's span with the page's normalized source path. */
function sectionOf(
  page: Page,
  section: { readonly pos: SourcePos; readonly text: string },
): PackSection {
  const span = { ...section.pos, file: sourceOf(page) };
  return { id: blockIdOf(span), text: section.text, span: formatSpan(span) };
}

/** One selected page, with its origin, build identity, locale, trust, kept sections, and shown Markdown. */
function itemOf(
  page: Page,
  content: string,
  trimmed: TrimResult | undefined,
  index: number,
  build: PackBuild,
  versions: ReadonlyMap<string, string>,
  snapshot: TrustSnapshot,
  ranked: RankedPage,
): PackItem {
  const source = sourceOf(page);
  const entry = snapshot.applies ? snapshot.pages.get(page.url)?.trust : undefined;
  const kept = trimmed?.pages[index];
  return {
    id: page.url,
    title: page.title,
    url: page.url,
    origin: { source, span: formatSpan({ ...page.source, file: source }) },
    version: versions.get(page.url) ?? null,
    locale: { lang: page.lang, dir: page.dir },
    build: build.id,
    hash: hashOf(page.markdown),
    rank: { score: ranked.score, reasons: ranked.reasons },
    ...(entry === undefined ? {} : { trust: entry }),
    sections: (kept?.keptSections ?? []).map((section) => sectionOf(page, section)),
    content,
  };
}

/** The header of one page section. */
function headerOf(page: Page, site: Site): string {
  return `## ${oneLine(page.title)}\n\n- URL: ${absoluteUrl(page.url, site)}\n- Source: \`${sourceOf(page)}\``;
}

/** The header of one structured item, so the Markdown and the JSON name the same origin. */
function headerOfItem(item: PackItem, site: Site): string {
  return `## ${oneLine(item.title)}\n\n- URL: ${absoluteUrl(item.url, site)}\n- Source: \`${item.origin.source}\``;
}

/** The pack's title line. */
function titleOf(topic: string): string {
  return `# Context pack: ${topic}`;
}

/** One page section while the pack is assembled. */
interface Section {
  readonly header: string;
  readonly body: string;
}

/** Assembles a pack: the title first, then one section per page, with one blank line between parts. */
function assemble(topic: string, sections: readonly Section[]): string {
  const parts = [titleOf(topic)];
  for (const section of sections) {
    parts.push(section.body === "" ? section.header : `${section.header}\n\n${section.body}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Drops a leading ATX level-one heading and the blank lines after it. */
function withoutLeadHeading(markdown: string): string {
  return markdown.replace(/^#[ \t]+[^\n]*(?:\n+|$)/, "").replace(/^\n+/, "");
}

/** Every link target in a page's Markdown and rendered HTML, in document order. */
function hrefsOf(page: Page): readonly string[] {
  const hrefs: string[] = [];
  for (const match of page.markdown.matchAll(MD_LINK)) hrefs.push(match[1] ?? "");
  for (const match of page.markdown.matchAll(MD_DEFINITION)) hrefs.push(match[1] ?? "");
  for (const match of page.html.matchAll(ANCHOR_HREF)) hrefs.push(match[1] ?? match[2] ?? match[3] ?? "");
  return hrefs;
}

/** The comparable form of a page URL for matching a link: no trailing slash. */
function comparableUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The page an `href` names, or `undefined` when it leaves the site or names no page. */
function pageForHref(
  href: string,
  from: Page,
  pages: readonly Page[],
  site: Site,
): Page | undefined {
  const value = href.trim().replace(/^<|>$/g, "");
  if (value === "" || value.startsWith("#") || EXTERNAL.test(value)) return undefined;

  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  if (path === "") return undefined;

  if (/\.(?:md|markdown)$/i.test(path)) {
    const source = path.startsWith("/")
      ? path.slice(1)
      : posix.normalize(posix.join(posix.dirname(sourceOf(from)), path));
    const normalized = source.replace(/^(?:\.\/)+/, "");
    return pages.find((page) => sourceOf(page) === normalized);
  }

  let pathname: string;
  try {
    const base = from.url.startsWith("/") ? from.url : `/${from.url}`;
    pathname = new URL(value, `${ORIGIN}${base}`).pathname;
  } catch {
    return undefined;
  }
  const candidate = comparableUrl(pathname);
  return pages.find((page) =>
    [page.url, underBase(page.url, site.config.base)].some((url) => comparableUrl(url) === candidate),
  );
}

/** The pages a selected page links to, in link order, without itself. */
function dependenciesOf(page: Page, pages: readonly Page[], site: Site): readonly Page[] {
  const found: Page[] = [];
  const seen = new Set<Page>();
  for (const href of hrefsOf(page)) {
    const target = pageForHref(href, page, pages, site);
    if (target === undefined || target === page || seen.has(target)) continue;
    seen.add(target);
    found.push(target);
  }
  return found;
}

/** The warnings the model attached to a page, in model order. */
function warningsOf(page: Page, warnings: readonly Diagnostic[]): readonly Diagnostic[] {
  const source = sourceOf(page);
  return warnings.filter(
    (diagnostic) =>
      diagnostic.severity === "warning" &&
      diagnostic.pos !== undefined &&
      diagnostic.pos.file.replace(/\\/g, "/") === source,
  );
}

/** The required evidence lines and trim items for one selected page. */
function evidenceOfPage(
  page: Page,
  request: ContextRequest,
  site: Site,
  pages: readonly Page[],
  versions: ReadonlyMap<Page, string | null>,
  warnings: readonly Diagnostic[],
  selected: ReadonlySet<Page>,
): PageEvidence {
  const lines: string[] = [];
  const required: RequiredEvidence[] = [];
  const add = (kind: string, text: string, pos: SourcePos): void => {
    lines.push(text);
    required.push({ id: `${kind}:${page.url}:${lines.length}`, kind, text, pos });
  };

  const requirement = request.requiredEvidence;
  if (requirement.source) {
    add("source", `- Source span: \`${formatSpan({ ...page.source, file: sourceOf(page) })}\``, page.source);
  }
  if (requirement.versions) {
    const folder = versions.get(page) ?? "current";
    add("version", `- Version: ${folder}; locale: ${page.lang}`, page.source);
  }
  if (requirement.warnings) {
    for (const diagnostic of warningsOf(page, warnings)) {
      const pos = diagnostic.pos;
      if (pos === undefined) continue;
      add("warning", `- Warning: ${oneLine(diagnostic.message)} (\`${formatSpan(pos)}\`)`, pos);
    }
  }
  if (requirement.dependencies) {
    for (const dependency of dependenciesOf(page, pages, site)) {
      if (selected.has(dependency)) continue;
      const text = `- Depends on: ${oneLine(dependency.title)} (${absoluteUrl(dependency.url, site)}, \`${sourceOf(dependency)}\`)`;
      add("dependency", text, dependency.source);
    }
  }

  return { lines, required };
}

/** Removes duplicate pages while keeping the first occurrence. */
function uniquePages(pages: readonly Page[]): readonly Page[] {
  const seen = new Set<Page>();
  const out: Page[] = [];
  for (const page of pages) {
    if (seen.has(page)) continue;
    seen.add(page);
    out.push(page);
  }
  return out;
}

/** Picks the forced and hinted pages, then ranked candidates, while their headers and mandatory leads fit. */
function selectPages(
  order: readonly Page[],
  forced: ReadonlySet<Page>,
  mandatory: ReadonlyMap<string, number>,
  limit: number,
  topic: string,
  site: Site,
): readonly Page[] {
  const selected: Page[] = [];
  let mandatorySum = 0;
  for (const page of order) {
    const cost = mandatory.get(page.url) ?? 0;
    if (selected.length === 0 || forced.has(page)) {
      selected.push(page);
      mandatorySum += cost;
      continue;
    }
    const overhead = estimateTokens(
      assemble(
        topic,
        [...selected, page].map((candidate) => ({ header: headerOf(candidate, site), body: "" })),
      ),
    ).tokens;
    if (overhead + mandatorySum + cost <= limit) {
      selected.push(page);
      mandatorySum += cost;
    }
  }
  return selected;
}

/**
 * Compiles one request, or returns `undefined` after reporting why it selected nothing.
 *
 * A valid request that matches no page, or whose required evidence cannot be kept, reports a
 * diagnostic and yields no output, so a caller never mistakes an empty pack for a complete one.
 */
export async function compilePack(
  site: Site,
  request: ContextRequest,
  ctx: OutputContext,
  options: CompileOptions = {},
): Promise<CompiledPack | undefined> {
  const docs = site.pages.filter((page) => page.kind === "doc");
  const versions = pageVersionsOf(site);
  const base = site.config.base;
  const topic = oneLine(request.task.goal) || "request";

  const candidates = docs.filter((page) => {
    if (!versionAllowed(versions.get(page) ?? null, request.constraints.version)) return false;
    if (!localeAllowed(page.lang, request.constraints.locale)) return false;
    return !request.exclude.some((hint) => namesPage(page, hint, base) || matchesTopic(page, hint));
  });
  const allowed = new Set(candidates);

  // A required page ref must name a page that the request's own constraints still allow. Silently
  // including it would break the constraint; silently dropping it would lose required evidence.
  const requiredPages: Page[] = [];
  for (const ref of request.requiredEvidence.refs) {
    const direct = docs.filter((page) => namesPage(page, ref, base));
    const byHeading =
      direct.length > 0
        ? []
        : docs.filter((page) => page.headings.some((heading) => heading.text === ref.trim()));
    const named = direct.length > 0 ? direct : byHeading;
    if (named.length === 0) continue;
    const blocked = named.filter((page) => !allowed.has(page));
    for (const page of blocked) {
      ctx.report({
        id: "context-pack.evidence-excluded",
        severity: "error",
        message: `Required evidence \`${ref}\` names ${page.url}, which the request's exclude list or constraints keep out.`,
        pos: page.source,
        help: "Remove the ref, or remove the exclude hint or constraint that keeps its page out.",
      });
    }
    if (blocked.length > 0) return undefined;
    requiredPages.push(...named);
  }
  const forced = new Set(uniquePages(requiredPages));

  const includePages: Page[] = [];
  const queryHints: string[] = [];
  for (const hint of request.include) {
    const named = pagesNamed(candidates, hint, base);
    if (named.length > 0) includePages.push(...named);
    else queryHints.push(hint);
  }

  const query = [request.task.goal, ...queryHints].join(" ").trim();

  // One build identity and one trust snapshot, decided before ranking, so the rank reasons and the
  // published items read the same measurements. Entries measured in another build name a build the
  // ranker does not, which is how they raise no page and publish no trust.
  const build = buildIdentityOf(site);
  const trust = options.trust ?? (await trustIndexOf(site));
  const snapshot = trustSnapshotOf(build.id, trust, options.trustBuild);

  const ranked = rankPages(candidates, query, {
    base,
    ...(request.task.kind === undefined ? {} : { task: request.task.kind }),
    ...(request.constraints.locale === undefined ? {} : { lang: request.constraints.locale }),
    ...(request.constraints.version?.exact === undefined ? {} : { version: request.constraints.version.exact }),
    build: build.id,
    trust: snapshot.evidence,
  });
  const order = uniquePages([
    ...[...forced].sort((a, b) => byCodePoint(a.url, b.url)),
    ...includePages,
    ...ranked.filter((entry) => entry.score > 0).map((entry) => entry.page),
  ]);

  if (order.length === 0) {
    ctx.report({
      id: "context-pack.no-pages",
      severity: "warning",
      message: `No page matches the request goal "${topic}" under its constraints.`,
      help: "Broaden the goal, add an include hint, or relax constraints.locale and constraints.version.",
    });
    return undefined;
  }

  const maxTokens = Math.max(0, request.budget.maxTokens);
  const reserved = request.budget.reservedTokens ?? 0;
  const probe = await trimPages(order, 0);
  const mandatory = new Map<string, { readonly tokens: number; readonly markdown: string }>();
  for (const page of probe.pages) mandatory.set(page.url, { tokens: page.tokens, markdown: page.markdown });

  let chosen = selectPages(
    order,
    forced,
    new Map([...mandatory].map(([url, value]) => [url, value.tokens])),
    maxTokens,
    topic,
    site,
  );
  const warnings = options.warnings ?? [];

  let trimmed: TrimResult | undefined;
  let bodies: string[] = [];
  let contents: string[] = [];
  let upper = 0;
  // Slack absorbs the difference between the overhead measured on empty bodies and the overhead the
  // exact final Markdown really adds, so the trim's limit and the final acceptance measure agree.
  let slack = 0;
  let evidence = new Map<string, PageEvidence>();
  for (;;) {
    const selected = new Set(chosen);
    evidence = new Map(
      chosen.map((page) => [
        page.url,
        evidenceOfPage(page, request, site, docs, versions, warnings, selected),
      ]),
    );
    const required = chosen.flatMap((page) => evidence.get(page.url)?.required ?? []);
    // The headers and separators the pack adds around trimmed content still spend the same budget.
    const overhead = estimateTokens(
      assemble(topic, chosen.map((page) => ({ header: headerOf(page, site), body: "" }))),
    ).upper;
    // A hard limit leaves nothing to the estimator's margin, and the reserve is held back from
    // optional sections. Required evidence may draw on it and is never trimmed.
    trimmed = await trimPages(chosen, Math.max(0, maxTokens - overhead - slack), {
      mode: "hard",
      reservedTokens: reserved,
      required,
      keep: request.requiredEvidence.refs,
    });
    bodies = chosen.map((page, index) =>
      withoutLeadHeading(trimmed?.pages[index]?.markdown ?? page.markdown),
    );
    contents = chosen.map((page, index) => {
      const lines = evidence.get(page.url)?.lines ?? [];
      const body = bodies[index] ?? "";
      if (lines.length === 0) return body;
      return body === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${body}`;
    });
    upper = estimateTokens(
      assemble(
        topic,
        chosen.map((page, index) => ({ header: headerOf(page, site), body: contents[index] ?? "" })),
      ),
    ).upper;
    // Final acceptance is the upper bound of the exact bytes, never a point estimate alone.
    if (upper <= maxTokens) break;
    if (chosen.length > 1) {
      let drop = -1;
      for (let index = chosen.length - 1; index >= 0; index -= 1) {
        if (!forced.has(chosen[index]!)) {
          drop = index;
          break;
        }
      }
      if (drop !== -1) {
        chosen = chosen.filter((_, index) => index !== drop);
        slack = 0;
        continue;
      }
    }
    // Only one page, or only forced pages, remain. A trim that is already over budget means no
    // feasible result exists: keep the required and mandatory content and let its warning say so.
    if (trimmed.status === "over-budget") break;
    slack += upper - maxTokens;
  }

  // Every named ref must still be named by a selected page or a kept section. A heading ref that no
  // heading matches, or a section id a page never had, is an error rather than silent partial evidence.
  const kept = trimmed?.pages ?? [];
  const unsatisfied = request.requiredEvidence.refs.filter((ref) => {
    if (chosen.some((page) => matchesPage(page, ref, base))) return false;
    return !kept.some((page) => page.keptSections.some((section) => section.id === ref || section.text === ref));
  });
  if (unsatisfied.length > 0) {
    for (const ref of unsatisfied) {
      ctx.report({
        id: "context-pack.missing-evidence",
        severity: "error",
        message: `Required evidence \`${ref}\` matches no selected page or kept section.`,
        help: "Name an existing page URL, source path, section id, or heading, or remove the ref.",
      });
    }
    return undefined;
  }

  // A trim diagnostic describes the trim's own serialization; the pack publishes it only when the
  // exact final Markdown is over budget, so a warning never contradicts the accounting it ships with.
  const packWarnings: Diagnostic[] = upper > maxTokens ? [...(trimmed?.diagnostics ?? [])] : [];
  if (upper > maxTokens && packWarnings.length === 0) {
    packWarnings.push({
      id: "context-pack.over-budget",
      severity: "warning",
      message: `Context pack "${topic}" needs up to ${upper} tokens by the estimator's bound, above its budget of ${maxTokens}; its required content is kept.`,
      ...(chosen[0] === undefined ? {} : { pos: chosen[0].source }),
      help: "Raise budget.maxTokens, lower budget.reservedTokens, shorten required evidence, or narrow the goal.",
    });
  }
  for (const diagnostic of packWarnings) ctx.report(diagnostic);

  const versionFolders = new Map<string, string>();
  for (const page of site.pages) {
    const folder = versions.get(page);
    if (folder !== null && folder !== undefined) versionFolders.set(page.url, folder);
  }
  const rankedByPage = new Map(ranked.map((entry) => [entry.page, entry]));
  const items = chosen.map((page, index) =>
    itemOf(page, contents[index] ?? "", trimmed, index, build, versionFolders, snapshot, rankedByPage.get(page)!),
  );

  // The Markdown and JSON are two renderings of this one item list, so they cannot name different evidence.
  const markdown = assemble(
    topic,
    items.map((item) => ({ header: headerOfItem(item, site), body: item.content })),
  );

  const omitted = ranked
    .filter((entry) => entry.score > 0 && !chosen.includes(entry.page))
    .map((entry): PackPageOmission => ({
      id: entry.page.url,
      span: formatSpan({ ...entry.page.source, file: sourceOf(entry.page) }),
      score: entry.score,
      reasons: entry.reasons,
      reason: "budget",
    }));
  const omissions = (trimmed?.omissions ?? []).map((omission): PackOmission => ({
    item: omission.url,
    id: omission.id,
    text: omission.text,
    span: formatSpan(omission.pos),
    tokens: omission.tokens,
    reason: omission.reason,
    ...(omission.duplicateOf === undefined
      ? {}
      : { duplicateOf: { item: omission.duplicateOf.url, section: omission.duplicateOf.id } }),
  }));
  const selection: PackSelection = { omitted, omissions };

  // The accounting splits the exact final serialization: bodies, provenance evidence, and the rest.
  const estimate = estimateTokens(markdown);
  const selectedTokens = bodies.reduce((sum, body) => sum + estimateTokens(body).tokens, 0);
  const requiredTokens = chosen.reduce(
    (sum, page) => sum + estimateTokens((evidence.get(page.url)?.lines ?? []).join("\n")).tokens,
    0,
  );
  const floorMarkdown = assemble(
    topic,
    chosen.map((page, index) => {
      const lines = evidence.get(page.url)?.lines ?? [];
      // When the trim is over budget it kept exactly the fixed content — mandatory sections and
      // pinned refs — so that is the smallest feasible serialization, not the mandatory probe.
      const fixed =
        trimmed?.status === "over-budget"
          ? trimmed.pages[index]?.markdown
          : mandatory.get(page.url)?.markdown;
      const body = withoutLeadHeading(fixed ?? page.markdown);
      return {
        header: headerOf(page, site),
        body: lines.length === 0 ? body : body === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${body}`,
      };
    }),
  );
  const floor = estimateTokens(floorMarkdown).tokens;
  const floorUpper = Math.ceil(floor * (1 + estimate.margin));
  const accounting: PackAccounting = {
    requested: maxTokens,
    reserved: floorUpper,
    selected: selectedTokens,
    required: requiredTokens,
    overhead: estimate.tokens - selectedTokens - requiredTokens,
    used: estimate.tokens,
    remaining: maxTokens - estimate.tokens,
    method: estimate.method,
    margin: estimate.margin,
    upper: estimate.upper,
    minimum: estimate.upper > maxTokens ? { tokens: floor, upper: floorUpper } : null,
  };

  const pack: PackEvidence = {
    version: 1,
    build,
    topic: { name: topic, query, budget: maxTokens },
    selection,
    items,
    accounting,
    coverage: coverageOf(items),
    warnings: packWarnings.map(warningOf),
  };

  return { evidence: pack, markdown };
}
