import type { Diagnostic, Severity } from "../contracts/diagnostic.ts";
import type { Direction } from "../contracts/config.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import type { SourcePos } from "../contracts/source.ts";
import { discoverVersions } from "../content/versions.ts";
import { version } from "../index.ts";
import { rankPages, type RankedPage, type RankReason } from "../packs/rank.ts";
import { estimateTokens } from "../packs/tokens.ts";
import { trimPages, type TrimmedPage, type TrimResult } from "../packs/trim.ts";
import { blockIdOf, formatSpan } from "../source/spans.ts";
import { buildHashOf, hashOf } from "./build-hash.ts";
import { trustReport, type TrustEntry, type TrustPageEntry } from "./trust.ts";

/**
 * Writes one ready-to-paste context pack per configured topic: `pack/<topic>.md`, and its structured twin
 * `pack/<topic>.json`.
 *
 * A pack is a Markdown file an agent can paste into a prompt without reading the site. Topics come from
 * `_data/context-packs.yml` (also readable as `_data/contextPacks.yml`), as a list of entries:
 *
 * ```yaml
 * - topic: Install
 *   query: install the engine   # optional; defaults to `topic`
 *   budget: 6000                # optional; estimated tokens, defaults to 6000
 *   pages: [/guide/install/, guide/setup.md]  # optional; restricts the candidates
 * ```
 *
 * For each topic the output ranks doc pages with {@link rankPages}, using `query` or the topic name. Pages
 * that match no query term are left out, unless `pages` names them explicitly. The candidates are then
 * trimmed with {@link trimPages} in its `hard` mode, which spends the budget like an ad-hoc context
 * request does: pages join only while the exact pack of their mandatory content stays within the
 * estimator's upper bound, and optional sections are kept in equal turns while the whole final
 * serialization — title, section headers, and separators included — still fits. So a pack that is not
 * diagnosed as over budget satisfies `accounting.upper <= budget` for its exact bytes, unless a page's
 * mandatory lead (its heading and first paragraph) leaves no feasible result. When that happens the
 * lead is kept, the pack is larger than the budget, the warning `pack.trim.over-budget` reports the
 * page and its source position, and `accounting.minimum` publishes the smallest feasible cost.
 *
 * Every page section is:
 *
 * ```markdown
 * ## Page title
 *
 * - URL: /guide/install/ (absolute when the site config has `url`)
 * - Source: `guide/install.md`
 *
 * The trimmed Markdown.
 * ```
 *
 * A leading `# Title` line in a page's Markdown is dropped, because the section header already names the
 * page. The budget counts the pack title, the section headers, and the trimmed Markdown, estimated with
 * {@link estimateTokens}. Slugs are ASCII: the topic is lower-cased, every run outside `[a-z0-9]` becomes
 * one `-`, leading and trailing `-` are removed, and two topics with the same slug get `-2`, `-3`, and so
 * on in input order. A topic with no slug left (a name written only in a non-Latin script, for example)
 * falls back to `topic-<position>`.
 *
 * Files are sorted by path, the input order never reaches the bytes otherwise, and the output reads no
 * clock, network, environment, or disk: the same model gives the same files.
 *
 * ## The structured twin
 *
 * Every topic also writes `pack/<topic>.json`, the same selected evidence in a form a tool can read. Both files
 * come from one {@link PackEvidence} model, so the structured items and the Markdown sections name the same pages,
 * in the same order. An item carries:
 *
 * - `id`: the page's URL, which stays the same across builds while the page keeps its address.
 * - `origin`: the source file and its span, using the source map's span format (`path:line:column-endLine:endColumn`).
 * - `version` and `locale`: the documentation version folder (`content/versions.ts`) and the page's `lang`/`dir`.
 * - `trust`: the page's trust level, reasons, and per-signal evidence states, from the same signals as `trust.json`
 *   (`./trust.ts`), or left out when trust cannot be read.
 * - `build`: the identity of the documentation build, and `hash`: the SHA-256 of the page's source body, the same
 *   value `.mizzen/manifest.json` records under `hashes.source`.
 * - `rank`: the page's score and the factor contributions that produced it, from the same ranking the pack
 *   used, so a reader sees why the page was selected.
 * - `sections`: the kept top-level sections, with their stable block ids and spans, and `content`: the exact
 *   Markdown the human-readable pack shows.
 *
 * The evidence also explains what is missing:
 *
 * - `selection.omitted`: every candidate page that ranked but did not fit the budget, in rank order, with its
 *   score and reasons and the stable reason `budget`.
 * - `selection.omissions`: every top-level section left out of a selected page, with its source span, token
 *   count, and the stable reason `budget` or `duplicate`; a duplicate names the kept item and section that
 *   replaced it.
 * - `accounting`: the requested budget, the tokens reserved for content the pack cannot drop, the selected
 *   bodies, the provenance evidence, the serialization overhead, the final Markdown estimate, what remains,
 *   the estimator's method and margin, its planning upper bound, and the minimum feasible cost when the pack
 *   is over budget. `selected + required + overhead` is exactly `used`, so no cost is hidden.
 * - `coverage`: one requirement per evidence kind a context request can demand (`source`, `version`,
 *   `warning`, `dependency`), each satisfied or explicitly unsatisfied with the item URLs it is missing for.
 *   Selecting a page never satisfies version or dependency evidence on its own; `warning` covers exactly the
 *   warnings this pack's own compilation published.
 * - `warnings`: every warning the pack's own compilation produced, with its source span.
 *
 * The build identity is the engine version plus one SHA-256 over every doc page's URL and source hash, using
 * `build-hash.ts`'s rule. No absolute path, clock, environment, or unselected page reaches either file.
 */

/** The `_data` key `_data/contextPacks.yml` loads under. */
const DATA_KEY = "contextPacks";

/** The `_data` key `_data/context-packs.yml` loads under. */
const KEBAB_DATA_KEY = "context-packs";

/** The token budget a topic gets when it names none. */
export const DEFAULT_BUDGET = 6000;

/** One topic after its value has been read and validated. The CLI's `pack` command reads the same shape. */
export interface PackTopic {
  /** The display name, collapsed to one line. */
  readonly topic: string;
  /** The trimmed token budget of the whole pack. */
  readonly budget: number;
  /** The ranking query; defaults to the topic. */
  readonly query: string;
  /** `undefined` when every doc page is a candidate; otherwise the page URLs or source paths named. */
  readonly pages: readonly string[] | undefined;
}

/** One selected section in the structured pack: its stable block id, heading text, and source span. */
export interface PackSection {
  /** The section's block id, `<file>:<line>:<column>`, the same id `trim.ts` matches `keep` against. */
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
  /** The heading's span in the source file. */
  readonly span: string;
}

/** Why a page's rank placed it where it did: the score and the contributions that sum to it. */
export interface PackRank {
  /** The relevance score; exactly the sum of {@link reasons}. */
  readonly score: number;
  /** The factor contributions, in the ranker's stable order. */
  readonly reasons: readonly RankReason[];
}

/** One selected page in the structured pack, with everything needed to trace its claims to the source. */
export interface PackItem {
  /** The page's URL: stable while the page keeps its address, and unique within a pack. */
  readonly id: string;
  /** The page title, as the pack section shows it. */
  readonly title: string;
  /** The output URL, including `base`. */
  readonly url: string;
  /** The source file (relative to the site root) and the span its content starts at. */
  readonly origin: { readonly source: string; readonly span: string };
  /** The documentation version folder, or `null` when the page is outside every version. */
  readonly version: string | null;
  /** The page's language and text direction. */
  readonly locale: { readonly lang: string; readonly dir: Direction };
  /** A reference to the pack's build identity, repeated so an item stands on its own. */
  readonly build: string;
  /** SHA-256 of the page's source body, the manifest's `hashes.source` value. */
  readonly hash: string;
  /** Why the page was selected: its score and the factor contributions behind it. */
  readonly rank: PackRank;
  /** The trust level, reasons, and per-signal evidence, or omitted when trust could not be read. */
  readonly trust?: TrustEntry;
  /** The kept top-level sections, in document order. */
  readonly sections: readonly PackSection[];
  /** The exact Markdown the human-readable pack shows for this page. */
  readonly content: string;
}

/** A candidate page that ranked but did not survive the budget. */
export interface PackPageOmission {
  /** The page's URL. */
  readonly id: string;
  /** The source file and the span its content starts at. */
  readonly span: string;
  /** Its relevance score. */
  readonly score: number;
  /** The factor contributions that produced {@link score}. */
  readonly reasons: readonly RankReason[];
  /** Why the page is not in the pack; only the budget can leave a ranked candidate out. */
  readonly reason: "budget";
}

/** One section left out of a selected page, with its source span and the stable reason. */
export interface PackOmission {
  /** The selected page the section belongs to. */
  readonly item: string;
  /** The section's block id, `<file>:<line>:<column>`. */
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
  /** The heading's span in the source file. */
  readonly span: string;
  /** The section's token estimate. */
  readonly tokens: number;
  /** `budget` when the budget could not keep it, `duplicate` when an earlier section repeated it. */
  readonly reason: "budget" | "duplicate";
  /** The kept item and section this one repeated, when the reason is `duplicate`. */
  readonly duplicateOf?: { readonly item: string; readonly section: string };
}

/** Why a candidate was selected or left out, in stable order. */
export interface PackSelection {
  /** Candidate pages the budget left out, in rank order. */
  readonly omitted: readonly PackPageOmission[];
  /** Sections left out of selected pages, in item and document order. */
  readonly omissions: readonly PackOmission[];
}

/** The minimum serialization that keeps every mandatory section. */
export interface PackMinimum {
  /** The token estimate of that serialization. */
  readonly tokens: number;
  /** {@link tokens} grown by the estimator's margin, rounded up. */
  readonly upper: number;
}

/** How the pack's budget was spent, with every cost visible. */
export interface PackAccounting {
  /** The topic's token budget: what the pack was asked to fit. */
  readonly requested: number;
  /** The planning upper bound of the content the pack cannot drop; optional sections cannot use it. */
  readonly reserved: number;
  /** The estimate of the selected item bodies: the content trimming may drop. */
  readonly selected: number;
  /** The estimate of the provenance evidence the pack publishes: each item's URL, source, and version lines. */
  readonly required: number;
  /** The estimate the serialization adds: the title, the section headings, and the separators. */
  readonly overhead: number;
  /** The estimate of the final Markdown file, byte for byte. */
  readonly used: number;
  /** `requested - used`; negative only when the pack is over budget. */
  readonly remaining: number;
  /** The estimator's name. */
  readonly method: string;
  /** The estimator's relative error margin. */
  readonly margin: number;
  /** `used` grown by {@link margin}, rounded up: the bound a hard limit should reserve. */
  readonly upper: number;
  /** The smallest feasible serialization when `used` exceeds {@link requested}; `null` otherwise. */
  readonly minimum: PackMinimum | null;
}

/** One kind of evidence a context request can demand. */
export type PackEvidenceKind = "source" | "version" | "warning" | "dependency";

/** Why a required evidence kind is not satisfied for some items. */
export type PackCoverageReason =
  | "source.missing"
  | "version.unknown"
  | "warning.unavailable"
  | "dependency.unavailable";

/** One evidence kind and whether the pack covers it for every selected item. */
export interface PackCoverageRequirement {
  /** The evidence kind. */
  readonly kind: PackEvidenceKind;
  /** Whether every selected item carries this evidence. */
  readonly satisfied: boolean;
  /** The item URLs the evidence is missing for; empty when satisfied. */
  readonly missing: readonly string[];
  /** A stable code when the requirement is unsatisfied. */
  readonly reason?: PackCoverageReason;
}

/** What required evidence the pack can prove, and what it explicitly cannot. */
export interface PackCoverage {
  /** One requirement per kind, in the fixed order source, version, warning, dependency. */
  readonly requirements: readonly PackCoverageRequirement[];
  /** The kinds that are not satisfied, in the same order. */
  readonly unsatisfied: readonly PackEvidenceKind[];
}

/** One warning the pack's own compilation produced. */
export interface PackWarning {
  /** Stable identifier, such as `pack.trim.over-budget`. */
  readonly id: string;
  /** The finding's severity. */
  readonly severity: Severity;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** The source span, with forward slashes, when the warning has a place. */
  readonly span?: string;
}

/** The identity of the documentation a pack was compiled from. */
export interface PackBuild {
  /** The engine version that wrote the pack. */
  readonly engine: string;
  /** SHA-256 over every doc page's URL and source hash, by `build-hash.ts`'s rule. */
  readonly id: string;
}

/** The topic a pack was compiled for, so a reader sees why this evidence was selected. */
export interface PackTopicEvidence {
  /** The display name. */
  readonly name: string;
  /** The ranking query that selected the pages. */
  readonly query: string;
  /** The token budget the Markdown pack was trimmed to. */
  readonly budget: number;
}

/** The structured form of one pack: the model both `pack/<slug>.json` and `pack/<slug>.md` are written from. */
export interface PackEvidence {
  /** The structured artifact's own format version. */
  readonly version: 1;
  /** The documentation build the selected evidence came from. */
  readonly build: PackBuild;
  /** Why this evidence was selected. */
  readonly topic: PackTopicEvidence;
  /** Why each candidate was selected or left out. */
  readonly selection: PackSelection;
  /** The selected pages, in pack order. */
  readonly items: readonly PackItem[];
  /** How the budget was spent, with every cost visible. */
  readonly accounting: PackAccounting;
  /** What required evidence the pack covers, and what it explicitly cannot. */
  readonly coverage: PackCoverage;
  /** Every warning the pack's own compilation produced. */
  readonly warnings: readonly PackWarning[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapses every run of whitespace to one space, so a value never breaks a line of the pack. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A page's source path with forward slashes, as the pack shows it. */
function sourceOf(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/**
 * The URL the pack shows for a page: absolute when the config has `url`, else the site-relative URL the
 * model carries (which includes `base`).
 */
function absoluteUrl(url: string, site: Site): string {
  const origin = site.config.url?.replace(/\/+$/, "");
  return origin === undefined || origin === "" ? url : `${origin}${url}`;
}

/**
 * The documentation build a pack was compiled from: the engine version plus one hash over every doc page's URL and
 * source hash. It uses `build-hash.ts`'s rule, so the same model gives the same identity on every machine, and an
 * edit to any page changes it. No clock, environment, or output folder is read.
 */
function buildIdentityOf(site: Site): PackBuild {
  const sources: Record<string, string> = {};
  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    // `build-hash.ts` names relative identities, so the URL loses its leading and trailing slashes. The full URL
    // stays in the value, so moving a page changes the identity even when its content does not.
    const key = page.url.replace(/^\/+|\/+$/g, "") || "index";
    sources[key] = hashOf(`${absoluteUrl(page.url, site)}\0${hashOf(page.markdown)}`);
  }
  return { engine: version, id: buildHashOf(sources) };
}

/** The documentation version folder of each page, by URL; `content/versions.ts` decides the rule. */
function versionsOf(site: Site): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const entry of discoverVersions(site.pages)) {
    if (entry.version !== null) versions.set(entry.page.url, entry.version);
  }
  return versions;
}

/** The trust fields of one `trust.json` page entry, without the join facts the pack already carries. */
function trustEntryOf(entry: TrustPageEntry): TrustEntry {
  return {
    evidence: entry.evidence,
    level: entry.level,
    reasons: entry.reasons,
    ...(entry.lastReviewer === undefined ? {} : { lastReviewer: entry.lastReviewer }),
  };
}

/**
 * The trust entry of every doc page, by URL, from the same signals and thresholds as `trust.json`. The helper reads
 * the site's data channels only (no root), so it never touches git, the clock, or the environment. `trust.json`
 * nests the entries under `pages` and repeats each page's URL in its entry, which is the field this joins on.
 */
async function trustIndexOf(site: Site): Promise<ReadonlyMap<string, TrustEntry>> {
  const [file] = await trustReport(site);
  if (file === undefined) return new Map();
  const report = JSON.parse(String(file.contents)) as { readonly pages: Readonly<Record<string, TrustPageEntry>> };
  return new Map(Object.values(report.pages).map((entry) => [entry.url, trustEntryOf(entry)]));
}

/** A span with the page's normalized source path, so a Windows model still writes forward slashes. */
function normalizedSpan(pos: SourcePos): string {
  return formatSpan({ ...pos, file: pos.file.replace(/\\/g, "/") });
}

/** A section's span with the page's normalized source path, so a Windows model still writes forward slashes. */
function sectionOf(page: Page, section: { readonly pos: Page["source"]; readonly text: string }): PackSection {
  const span = { ...section.pos, file: sourceOf(page) };
  return { id: blockIdOf(span), text: section.text, span: formatSpan(span) };
}

/** One selected page, with its origin, build identity, locale, rank, trust, kept sections, and shown Markdown. */
function itemOf(
  page: Page,
  content: string,
  trimmed: TrimmedPage | undefined,
  build: PackBuild,
  versions: ReadonlyMap<string, string>,
  trust: ReadonlyMap<string, TrustEntry>,
  ranked: RankedPage,
): PackItem {
  const source = sourceOf(page);
  const entry = trust.get(page.url);
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
    sections: (trimmed?.keptSections ?? []).map((section) => sectionOf(page, section)),
    content,
  };
}

/** The facts a page header shows, which a page and a structured item both carry. */
interface HeaderFacts {
  readonly title: string;
  readonly url: string;
  readonly origin: { readonly source: string };
  readonly version: string | null;
}

/** The required provenance evidence of one item: its URL, source, and version when known. */
function evidenceLinesOf(facts: HeaderFacts, site: Site): readonly string[] {
  return [
    `- URL: ${absoluteUrl(facts.url, site)}`,
    `- Source: \`${facts.origin.source}\``,
    ...(facts.version === null ? [] : [`- Version: ${facts.version}`]),
  ];
}

/** A page section's header, built from facts both the page model and the structured item carry. */
function headerOfFacts(facts: HeaderFacts, site: Site): string {
  return `## ${oneLine(facts.title)}\n\n${evidenceLinesOf(facts, site).join("\n")}`;
}

/** The header of one page section, without the body. */
function headerOfPage(page: Page, site: Site, pageVersion: string | null): string {
  return headerOfFacts(
    { title: page.title, url: page.url, origin: { source: sourceOf(page) }, version: pageVersion },
    site,
  );
}

/** The header of one structured item, so the Markdown and the JSON name the same origin. */
function headerOfItem(item: PackItem, site: Site): string {
  return headerOfFacts(item, site);
}

/** One candidate page's mandatory content: its lead and any mandatory section, with its token estimate. */
interface MandatoryContent {
  readonly tokens: number;
  readonly markdown: string;
}

/** Every candidate page trimmed to zero, so its mandatory content and cost are known before selection. */
async function mandatoryOf(pages: readonly Page[]): Promise<ReadonlyMap<string, MandatoryContent>> {
  const probe = await trimPages(pages, 0);
  const costs = new Map<string, MandatoryContent>();
  for (const page of probe.pages) costs.set(page.url, { tokens: page.tokens, markdown: page.markdown });
  return costs;
}

/** One page's rank reasons that produced its score. */
function rankOf(page: Page, ranked: ReadonlyMap<Page, RankedPage>): RankedPage {
  const entry = ranked.get(page);
  if (entry === undefined) throw new Error(`page ${page.url} was not ranked`);
  return entry;
}

/** Every warning the compiler emitted, with the source path in forward slashes. */
export function warningOf(diagnostic: Diagnostic): PackWarning {
  return {
    id: diagnostic.id,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.pos === undefined ? {} : { span: normalizedSpan(diagnostic.pos) }),
  };
}

/** One coverage requirement: satisfied when no item is missing the evidence. */
function requirementOf(
  kind: PackEvidenceKind,
  missing: readonly string[],
  reason: PackCoverageReason,
): PackCoverageRequirement {
  return missing.length === 0
    ? { kind, satisfied: true, missing: [] }
    : { kind, satisfied: false, missing, reason };
}

/**
 * What the pack can prove about the four evidence kinds a context request can require.
 *
 * `source` is covered by every item's origin. `version` is covered only by items inside a version folder; a
 * selected page outside one leaves it explicitly unsatisfied, never silently covered. `warning` is covered
 * because the pack publishes every warning its own compilation produced. `dependency` is not available in
 * the site model, so it names every item as missing rather than claiming a page selection proved it.
 */
export function coverageOf(items: readonly PackItem[]): PackCoverage {
  const source = items
    .filter((item) => item.origin.source === "" || !item.origin.span.startsWith(`${item.origin.source}:`))
    .map((item) => item.id);
  const version = items.filter((item) => item.version === null).map((item) => item.id);
  const dependency = items.map((item) => item.id);
  const requirements: readonly PackCoverageRequirement[] = [
    requirementOf("source", source, "source.missing"),
    requirementOf("version", version, "version.unknown"),
    requirementOf("warning", [], "warning.unavailable"),
    requirementOf("dependency", dependency, "dependency.unavailable"),
  ];
  return {
    requirements,
    unsatisfied: requirements.filter((requirement) => !requirement.satisfied).map((requirement) => requirement.kind),
  };
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

/**
 * Drops a leading ATX level-one heading and the blank lines after it. The pack's section header names the
 * page already, so keeping the page's own `# Title` would duplicate it and break the heading outline.
 */
function withoutLeadHeading(markdown: string): string {
  return markdown.replace(/^#[ \t]+[^\n]*(?:\n+|$)/, "").replace(/^\n+/, "");
}

/** The slug a topic's file is named after: lower-case ASCII letters, digits, and single hyphens. */
export function slugOf(topic: string): string {
  return topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A slug that no earlier topic took, adding `-2`, `-3`, and so on in input order. */
function uniqueSlug(base: string, used: Set<string>, position: number): string {
  const start = base === "" ? `topic-${position}` : base;
  let candidate = start;
  for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${start}-${suffix}`;
  used.add(candidate);
  return candidate;
}

/** A page's URL without the site `base`, for matching `pages` entries written as site paths. */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** Whether a `pages` entry names a page, by URL (with or without `base` and a trailing slash) or source path. */
function matchesReference(page: Page, reference: string, base: string): boolean {
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

/** Reads `topic`, `budget`, `query`, and `pages` from one entry, reporting what it cannot use. */
export function readPackTopic(entry: unknown, position: number, ctx: OutputContext): PackTopic | undefined {
  if (!isMapping(entry)) {
    ctx.report({
      id: "context-pack.invalid-topic",
      severity: "warning",
      message: `Context pack entry ${position} is not a mapping with a \`topic\`.`,
      help: "Write `- topic: Install` or `- { topic: Install, budget: 6000 }` in `_data/context-packs.yml`.",
    });
    return undefined;
  }

  const topic = typeof entry.topic === "string" ? oneLine(entry.topic) : "";
  if (topic === "") {
    ctx.report({
      id: "context-pack.invalid-topic",
      severity: "warning",
      message: `Context pack entry ${position} has no topic name.`,
      help: "Give every entry a non-empty `topic`.",
    });
    return undefined;
  }

  let budget = DEFAULT_BUDGET;
  if (entry.budget !== undefined) {
    if (typeof entry.budget === "number" && Number.isFinite(entry.budget) && entry.budget >= 1) {
      budget = Math.floor(entry.budget);
    } else {
      ctx.report({
        id: "context-pack.invalid-budget",
        severity: "warning",
        message: `Context pack "${topic}" has a budget that is not a positive number; ${DEFAULT_BUDGET} tokens are used.`,
        help: "Set `budget` to a positive integer number of estimated tokens.",
      });
    }
  }

  const query = typeof entry.query === "string" && oneLine(entry.query) !== "" ? oneLine(entry.query) : topic;

  let pages: readonly string[] | undefined;
  if (entry.pages !== undefined) {
    if (Array.isArray(entry.pages) && entry.pages.every((value) => typeof value === "string")) {
      pages = entry.pages.map((value: string) => value.trim()).filter((value) => value !== "");
    } else {
      ctx.report({
        id: "context-pack.invalid-pages",
        severity: "warning",
        message: `Context pack "${topic}" has a \`pages\` value that is not a list of strings; every page is a candidate.`,
        help: "List page URLs or source paths, such as `/guide/install/` or `guide/install.md`.",
      });
    }
  }

  return { topic, budget, query, pages };
}

/** The topic list from `site.data`, or `undefined` when the key is absent or unusable. */
export function readPackTopics(site: Site, ctx: OutputContext): readonly unknown[] | undefined {
  const raw = site.data[DATA_KEY] !== undefined ? site.data[DATA_KEY] : site.data[KEBAB_DATA_KEY];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    ctx.report({
      id: "context-pack.invalid-data",
      severity: "warning",
      message: "`context-packs` must be a list of topics.",
      help: "Write `- topic: Install` entries in `_data/context-packs.yml`.",
    });
    return undefined;
  }
  return raw;
}

/** The candidates for a topic, in ranking order, with the reasons that ranked them. */
function candidatesOf(site: Site, topic: PackTopic): readonly RankedPage[] {
  const docs = site.pages.filter((page) => page.kind === "doc");
  const ranked = rankPages(docs, topic.query, { base: site.config.base });
  const named = topic.pages;
  if (named === undefined) return ranked.filter((entry) => entry.score > 0);
  return ranked.filter((entry) =>
    named.some((reference) => matchesReference(entry.page, reference, site.config.base)),
  );
}

/** A topic with no pages is reported, not written. */
function noPagesDiagnostic(topic: PackTopic): Diagnostic {
  return {
    id: "context-pack.no-pages",
    severity: "warning",
    message:
      topic.pages === undefined
        ? `Context pack "${topic.topic}" has no pages: no page matches the query "${topic.query}".`
        : `Context pack "${topic.topic}" names pages that the site does not have or that do not match the query "${topic.query}".`,
    help: "Add a page that covers the topic, change `query`, or name `pages` with existing page URLs or source paths.",
  };
}

/** One topic's finished pack: the Markdown file and the structured model both files come from. */
export interface PackContents {
  /** The topic's file name, without `.md` or `.json`. */
  readonly slug: string;
  /** The pack's Markdown. */
  readonly contents: string;
  /** The structured form of the same selected evidence. */
  readonly evidence: PackEvidence;
}

/** Options of {@link buildPack}. */
export interface BuildPackOptions {
  /** The trust entries to use, by URL; computed from the site's data when absent. */
  readonly trust?: ReadonlyMap<string, TrustEntry>;
}

/** Builds one pack, or `undefined` when the topic has no pages. */
export async function buildPack(
  site: Site,
  topic: PackTopic,
  ctx: OutputContext,
  options: BuildPackOptions = {},
): Promise<PackContents | undefined> {
  const candidates = candidatesOf(site, topic);
  if (candidates.length === 0) {
    ctx.report(noPagesDiagnostic(topic));
    return undefined;
  }

  const versions = versionsOf(site);
  const ranked = new Map(candidates.map((entry) => [entry.page, entry]));
  const pageVersion = (page: Page): string | null => versions.get(page.url) ?? null;
  const headerOf = (page: Page): string => headerOfPage(page, site, pageVersion(page));
  const pairs = candidates.map((entry) => entry.page);
  const mandatory = await mandatoryOf(pairs);
  const mandatoryBody = (page: Page): string => withoutLeadHeading(mandatory.get(page.url)?.markdown ?? page.markdown);

  // Select pages in ranking order while the exact pack of their mandatory content stays inside the
  // budget's planning upper bound, so an optional page never joins by a point estimate alone. The
  // first page is always kept, so a topic whose best page alone exceeds the budget still produces a
  // pack and a warning.
  const selected: Page[] = [];
  for (const page of pairs) {
    const next = [...selected, page];
    const cost = estimateTokens(
      assemble(
        topic.topic,
        next.map((candidate) => ({ header: headerOf(candidate), body: mandatoryBody(candidate) })),
      ),
    ).upper;
    if (selected.length === 0 || cost <= topic.budget) selected.push(page);
  }

  // Trim in the hard mode, which prices the whole serialization by the estimator's upper bound, and
  // then re-check the exact final bytes: the title, the section headers, and the separators spend
  // the same bound the pack promises. `slack` absorbs any difference between the overhead measured
  // on empty bodies and the overhead the final serialization really adds. While the final upper
  // bound is over budget the lowest-ranked page gives way; when only one page is left and even its
  // mandatory content cannot fit, the pack keeps that content whole and publishes the trim
  // diagnostics that say so.
  let chosen = selected;
  let diagnostics: readonly Diagnostic[] = [];
  let trim: TrimResult | undefined;
  let bodies: readonly string[] = [];
  let slack = 0;
  for (;;) {
    const overheadUpper = estimateTokens(
      assemble(topic.topic, chosen.map((page) => ({ header: headerOf(page), body: "" }))),
    ).upper;
    const trimmed = await trimPages(chosen, Math.max(0, topic.budget - overheadUpper - slack), { mode: "hard" });
    bodies = chosen.map((page, index) => withoutLeadHeading(trimmed.pages[index]?.markdown ?? page.markdown));
    const contents = assemble(
      topic.topic,
      chosen.map((page, index) => ({ header: headerOf(page), body: bodies[index]! })),
    );
    const used = estimateTokens(contents);
    if (used.upper <= topic.budget) {
      diagnostics = [];
      trim = trimmed;
      break;
    }
    if (chosen.length > 1) {
      chosen = chosen.slice(0, -1);
      slack = 0;
      continue;
    }
    if (trimmed.status === "over-budget") {
      // No feasible result exists: the mandatory lead is kept whole, and the warning says so.
      trim = trimmed;
      diagnostics =
        trimmed.diagnostics.length > 0
          ? trimmed.diagnostics
          : [
              {
                id: "context-pack.over-budget",
                severity: "warning",
                message: `Context pack "${topic.topic}" is ${used.tokens} tokens, above its budget of ${topic.budget}; its mandatory lead is kept.`,
                pos: chosen[0]!.source,
                help: "Raise `budget`, shorten the page's lead, or rank a different page.",
              },
            ];
      break;
    }
    slack += used.upper - topic.budget;
  }

  for (const diagnostic of diagnostics) ctx.report(diagnostic);

  const build = buildIdentityOf(site);
  const trust = options.trust ?? (await trustIndexOf(site));
  const items = chosen.map((page, index) =>
    itemOf(page, bodies[index] ?? "", trim?.pages[index], build, versions, trust, rankOf(page, ranked)),
  );

  // The human-readable pack is rendered from the same items, so the two files cannot name different evidence.
  const contents = assemble(
    topic.topic,
    items.map((item) => ({ header: headerOfItem(item, site), body: item.content })),
  );

  const omitted = candidates
    .filter((entry) => !chosen.includes(entry.page))
    .map((entry): PackPageOmission => ({
      id: entry.page.url,
      span: formatSpan({ ...entry.page.source, file: sourceOf(entry.page) }),
      score: entry.score,
      reasons: entry.reasons,
      reason: "budget",
    }));
  const omissions = (trim?.omissions ?? []).map((omission): PackOmission => ({
    item: omission.url,
    id: omission.id,
    text: omission.text,
    span: normalizedSpan(omission.pos),
    tokens: omission.tokens,
    reason: omission.reason,
    ...(omission.duplicateOf === undefined
      ? {}
      : { duplicateOf: { item: omission.duplicateOf.url, section: omission.duplicateOf.id } }),
  }));

  // The accounting splits the exact final serialization: bodies, provenance evidence, and the rest.
  const estimate = estimateTokens(contents);
  const selectedTokens = items.reduce((sum, item) => sum + estimateTokens(item.content).tokens, 0);
  const requiredTokens = items.reduce(
    (sum, item) => sum + estimateTokens(evidenceLinesOf(item, site).join("\n")).tokens,
    0,
  );
  const floorMarkdown = assemble(
    topic.topic,
    chosen.map((page) => ({
      header: headerOf(page),
      body: withoutLeadHeading(mandatory.get(page.url)?.markdown ?? page.markdown),
    })),
  );
  const floor = estimateTokens(floorMarkdown).tokens;
  const floorUpper = Math.ceil(floor * (1 + estimate.margin));
  const accounting: PackAccounting = {
    requested: topic.budget,
    reserved: floorUpper,
    selected: selectedTokens,
    required: requiredTokens,
    overhead: estimate.tokens - selectedTokens - requiredTokens,
    used: estimate.tokens,
    remaining: topic.budget - estimate.tokens,
    method: estimate.method,
    margin: estimate.margin,
    upper: estimate.upper,
    minimum: diagnostics.length > 0 ? { tokens: floor, upper: floorUpper } : null,
  };

  const evidence: PackEvidence = {
    version: 1,
    build,
    topic: { name: topic.topic, query: topic.query, budget: topic.budget },
    selection: { omitted, omissions },
    items,
    accounting,
    coverage: coverageOf(items),
    warnings: diagnostics.map(warningOf),
  };

  return { slug: slugOf(topic.topic), contents, evidence };
}

/**
 * Writes `pack/<topic>.md` and `pack/<topic>.json` for every topic in `_data/context-packs.yml`. No topics means no
 * files.
 *
 * The file name is the sanitized topic slug (see the rule at the top of this module), files are sorted by
 * path, and a topic with no candidate page is reported with `context-pack.no-pages` instead of writing an
 * empty pack. A malformed data file or topic entry is a warning, not a build failure, and produces no file
 * for that entry. The trust entries are read once for the whole run, from the site's data channels.
 */
export const contextPack: Output = {
  name: "context-pack",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const raw = readPackTopics(site, ctx);
    if (raw === undefined) return [];

    const used = new Set<string>();
    const files: OutputFile[] = [];
    let trust: ReadonlyMap<string, TrustEntry> | undefined;
    for (let index = 0; index < raw.length; index += 1) {
      const topic = readPackTopic(raw[index], index + 1, ctx);
      if (topic === undefined) continue;
      trust ??= await trustIndexOf(site);
      const pack = await buildPack(site, topic, ctx, { trust });
      if (pack === undefined) continue;
      const slug = uniqueSlug(pack.slug, used, index + 1);
      files.push({ path: `pack/${slug}.json`, contents: `${JSON.stringify(pack.evidence, null, 2)}\n` });
      files.push({ path: `pack/${slug}.md`, contents: pack.contents });
    }

    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
