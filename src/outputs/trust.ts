import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { compareClaims } from "../drift/compare.ts";
import { examplesOf } from "../markdown/plugins/example-fence.ts";
import { reviewers, UNKNOWN as REVIEW_UNKNOWN, type Review } from "../model/reviewers.ts";
import {
  trustScore,
  type TrustExamples,
  type TrustLevel,
  type TrustReasonCode,
  type TrustScoreOptions,
  type TrustThresholds,
} from "../model/trust-score.ts";
import { hashOf } from "./build-hash.ts";

/**
 * Writes `trust.json`: one entry per doc page, keyed by its URL, with a stable page key and a build
 * identifier so a consumer can join the evidence to the page that was rendered without guessing from
 * source paths (N14). A theme can render its trust chip from this file.
 *
 * ## Shape
 *
 * The file is one JSON object with `version`, `build`, and `pages`, in that order:
 *
 * ```json
 * {
 *   "version": 1,
 *   "build": {
 *     "algorithm": "sha256",
 *     "id": "…64 hex…",
 *     "pages": 1
 *   },
 *   "pages": {
 *     "/guide/install/": {
 *       "key": "…64 hex…",
 *       "url": "/guide/install/",
 *       "source": "guide/install.md",
 *       "evidence": {
 *         "examples": "measured",
 *         "drift": "measured",
 *         "review": "measured"
 *       },
 *       "level": "verified",
 *       "reasons": [
 *         { "code": "examples.passed", "message": "No example fails; 2 of 2 pass." },
 *         { "code": "drift.clean", "message": "No drift findings." },
 *         { "code": "review.recent", "message": "Last reviewed 9 days ago, within the 180-day limit." }
 *       ],
 *       "lastReviewer": "Ada Lovelace"
 *     }
 *   }
 * }
 * ```
 *
 * Every page key in `pages` is a page URL, including the site's `base`, and the keys come in code-point
 * order. A page's `key` is the SHA-256 of its URL, a NUL, and its source file: two builds of the same
 * page carry the same key, and the entry also carries the URL and source file it belongs to, so no
 * consumer has to derive them from the filesystem. `build.id` is the SHA-256 of one line per doc page
 * (page key, Markdown hash, HTML hash), sorted by URL: the same rendered pages share one build
 * identifier, and changing a page's URL, source, Markdown, or HTML changes it.
 *
 * `level` is `verified`, `review-due`, or `at-risk`, exactly as N12's {@link trustScore} decides.
 * `reasons` always has three entries, in the fixed order examples, drift, review. `lastReviewer` is
 * present only when the last commit that touched the page has a non-empty author name. The JSON uses
 * two-space indentation and one trailing LF, and `schema/trust.schema.json` describes the same shape.
 *
 * ## Evidence
 *
 * Every rendered content page gets an entry, and `evidence` says what each signal actually measured:
 *
 * - `examples`: `measured` (the page's examples have counts), `none` (the page declares no `test`
 *   fence), or `unknown` (the page declares examples but their result is unavailable).
 * - `drift`: `measured` (a finding count exists, including zero), `missing` (no drift data and no root
 *   to check), or `unknown` (the check was available but gave no answer).
 * - `review`: `measured` (a review date exists), `missing` (no reviewer data and no root to ask), or
 *   `unknown` (git was available but names no date for the page).
 *
 * A signal that is not `measured` also has an explaining reason in `reasons`, so no page is silently
 * treated as healthy. `examples: "none"` is known evidence, not a gap: the page has no examples to run.
 *
 * ## Where the signals come from
 *
 * Every signal is read through a data channel the site or the caller controls, never from another
 * output's return value: outputs run before anything is written and their results are not shared.
 *
 * - **Examples.** First the caller's `examples` option, then `site.data.examples`. Both accept N06's
 *   `examplesReport` shape (`{ pages: [{ url, total, passed, failed, skipped }] }`) and the URL-keyed
 *   shape the tested chip documents (`{ "/guide/": { passed, failed, total? } }`). A page that
 *   declares `test` fences but has no matching counts is `examples.unknown` and `at-risk`: the build
 *   cannot know whether they pass, so it never claims they do. A page with no `test` fence keeps N12's
 *   neutral `examples.none`; it is not penalized for having no examples.
 * - **Drift.** First the caller's `drift` option, then `site.data.drift`. A value is either a bare
 *   finding count (`{ "/guide/": 0 }`) or an entry with `findings`. Without data, and when a root is
 *   known, {@link compareClaims} counts the diagnostics for each page's source file. Without either,
 *   N12's `drift.unknown` makes the page `at-risk`.
 * - **Review.** First the caller's `reviewers` option, then `site.data.reviewers`, with `{ date,
 *   author }` per URL or an `{ pages: [...] }` list. Without an entry, and when a root is known, N13's
 *   {@link reviewers} reads the last commit of the page's source file. The review age is whole days
 *   from that commit to `asOf`; without a date or `asOf`, it is `"unknown"` and the page is
 *   `review-due`, never silently `verified`.
 *
 * `asOf` is the caller's option, or `SOURCE_DATE_EPOCH` (seconds since the Unix epoch) when the output
 * runs itself. Nothing reads the clock: a build without either reports review ages as unknown.
 *
 * ## Root
 *
 * `OutputContext` has no root, so the output reads `MIZZEN_SITE_ROOT` and falls back to the process's
 * working directory. The exported helper takes `root` as an option instead, which is what tests and
 * callers use. Root is a machine input, like git history: a copy of the site built from another folder,
 * or without git, reports drift or review as unknown unless the data files carry the answers. Set
 * `MIZZEN_SITE_ROOT` when the build's working directory is not the site root.
 *
 * ## Determinism
 *
 * The file is sorted by URL, has a fixed key order, and carries no timestamp, duration, or run order.
 * `compareClaims` and `reviewers` are deterministic for a fixed root and history, and the reviewers
 * answer is cached per path for the life of the process. Two builds with the same model, data, root,
 * and `SOURCE_DATE_EPOCH` write the same bytes.
 *
 * App and asset pages are left out: they are programs or files, not documents with examples, drift,
 * and a reviewer.
 */

/** The environment variable that names the site root, since {@link OutputContext} carries none. */
export const SITE_ROOT_ENV = "MIZZEN_SITE_ROOT";

/** The reproducible-build variable the output reads as `asOf`, in seconds since the Unix epoch. */
export const AS_OF_ENV = "SOURCE_DATE_EPOCH";

/** The shape version of `trust.json`. */
export const TRUST_VERSION = 1;

/** Milliseconds in a whole day. */
const DAY = 86_400_000;

/** A reason code this output can add to N12's set. */
export type TrustEntryCode = TrustReasonCode | "examples.unknown";

/** One reason in `trust.json`, with the same shape as N12's and one extra code. */
export interface TrustEntryReason {
  /** A stable identifier; the same finding always gets the same code. */
  readonly code: TrustEntryCode;
  /** The sentence a reader sees. */
  readonly message: string;
}

/** What one signal measured, or why it did not. */
export type TrustSignalState = "measured" | "none" | "missing" | "unknown";

/** Per-signal evidence states, in the fixed order examples, drift, review. */
export interface TrustEvidence {
  /** `measured`, `none` when no example is declared, or `unknown` when results are unavailable. */
  readonly examples: Exclude<TrustSignalState, "missing">;
  /** `measured`, `missing` when nothing could check drift, or `unknown` when the check gave no answer. */
  readonly drift: Exclude<TrustSignalState, "none">;
  /** `measured`, `missing` when no review source exists, or `unknown` when it names no date. */
  readonly review: Exclude<TrustSignalState, "none">;
}

/** One page's entry in `trust.json`, in key order. */
export interface TrustEntry {
  /** What each signal measured, or why it did not. */
  readonly evidence: TrustEvidence;
  /** The worst level the reasons support. */
  readonly level: TrustLevel;
  /** Exactly three reasons, ordered examples, drift, review. */
  readonly reasons: readonly TrustEntryReason[];
  /** The last commit's author name, when it is known. */
  readonly lastReviewer?: string;
}

/** One rendered page's entry in `trust.json`, with the facts a consumer joins on. */
export interface TrustPageEntry extends TrustEntry {
  /** Stable page key: SHA-256 of the URL, a NUL, and the source file. */
  readonly key: string;
  /** Output URL, including `base`. */
  readonly url: string;
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
}

/** The identity of the rendered pages the evidence belongs to. */
export interface TrustBuild {
  /** The digest the `id` was made with. */
  readonly algorithm: "sha256";
  /** SHA-256 over every doc page's key, Markdown hash, and HTML hash, sorted by URL. */
  readonly id: string;
  /** How many rendered content pages the build has. */
  readonly pages: number;
}

/** The whole `trust.json` body, in key order. */
export interface TrustReport {
  readonly version: typeof TRUST_VERSION;
  readonly build: TrustBuild;
  readonly pages: Readonly<Record<string, TrustPageEntry>>;
}

/** What the pure entry builder reads, with everything already resolved. */
export interface TrustSignals {
  /** The page's example counts, or `"unknown"` when it declares examples but their result is unavailable. */
  readonly examples?: TrustExamples | "unknown";
  /** The page's drift finding count; absent means drift was not checked. */
  readonly drift?: number;
  /** The page's last review, or `UNKNOWN` when git has no answer. */
  readonly review?: Review | typeof REVIEW_UNKNOWN;
  /** The instant to measure the review age from; absent means the age is unknown. */
  readonly asOf?: Date;
  /** Why drift has no count; only read when `drift` is absent. Default `missing`. */
  readonly driftState?: "missing" | "unknown";
  /** Why review has no date; only read when `review` is absent or `UNKNOWN`. Default `missing`. */
  readonly reviewState?: "missing" | "unknown";
}

/** Options of {@link trustReport}; every field has a default. */
export interface TrustReportOptions {
  /** Site root for the drift and review lookups. Default: no root, so both are unknown unless data carries them. */
  readonly root?: string;
  /** The instant review ages are measured from: a `Date` or an ISO 8601 string. Default: unknown. */
  readonly asOf?: Date | string;
  /** Example data, in either shape documented above. Default: `site.data.examples`. */
  readonly examples?: unknown;
  /** Drift data, in either shape documented above. Default: `site.data.drift`. */
  readonly drift?: unknown;
  /** Reviewer data, in either shape documented above. Default: `site.data.reviewers`. */
  readonly reviewers?: unknown;
  /** Review-due threshold overrides. Default: N12's threshold. */
  readonly thresholds?: TrustThresholds;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a plain object, which is what a YAML mapping or a JSON object becomes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole, non-negative number from a YAML or JSON value; strings are read as numbers, as the chip reads them. */
function numberOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.trunc(number));
}

/**
 * `[url, value]` pairs from a data value. The accepted shapes are a URL-keyed object, `{ pages: { url:
 * value } }`, and `{ pages: [{ url, ... }] }`; an array of entries with a `url` also works. Anything
 * else gives no pairs, so malformed data reads as unavailable instead of as a wrong answer.
 */
function urlPairs(value: unknown): readonly (readonly [string, unknown])[] {
  if (Array.isArray(value)) {
    const pairs: (readonly [string, unknown])[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const url = entry.url;
      if (typeof url === "string" && url !== "") pairs.push([url, entry]);
    }
    return pairs;
  }
  if (!isRecord(value)) return [];

  const pages = value.pages;
  if (Array.isArray(pages)) return urlPairs(pages);
  if (isRecord(pages)) return Object.entries(pages).filter(([url]) => url.startsWith("/"));
  if (pages !== undefined) return [];
  return Object.entries(value).filter(([url]) => url.startsWith("/"));
}

/** The example counts, by URL, from either documented shape. */
function examplesIndexOf(value: unknown): Map<string, TrustExamples> {
  const index = new Map<string, TrustExamples>();
  for (const [url, entry] of urlPairs(value)) {
    if (!isRecord(entry)) continue;
    const total = numberOf(entry.total);
    const passed = numberOf(entry.passed);
    const failed = numberOf(entry.failed);
    if (total === undefined && passed === undefined && failed === undefined) continue;
    const pass = passed ?? 0;
    const fail = failed ?? 0;
    index.set(url, { total: Math.max(total ?? 0, pass + fail), passed: pass, failed: fail });
  }
  return index;
}

/** The drift finding counts, by URL, from a bare number or an entry's `findings`. */
function driftIndexOf(value: unknown): Map<string, number> {
  const index = new Map<string, number>();
  for (const [url, entry] of urlPairs(value)) {
    const findings = numberOf(isRecord(entry) ? entry.findings : entry);
    if (findings !== undefined) index.set(url, findings);
  }
  return index;
}

/** The last reviews, by URL, from `{ date, author }` entries; an entry without both is skipped. */
function reviewIndexOf(value: unknown): Map<string, Review> {
  const index = new Map<string, Review>();
  for (const [url, entry] of urlPairs(value)) {
    if (!isRecord(entry)) continue;
    const author = typeof entry.author === "string" ? entry.author.trim() : "";
    const text = typeof entry.date === "string" ? entry.date.trim() : "";
    if (author === "" || text === "") continue;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) continue;
    index.set(url, { date: date.toISOString(), author });
  }
  return index;
}

/** The instant an option asks for, or `undefined` when it is absent or not a date. */
function asOfOf(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Whole days from the review to `asOf`; unknown without both, and never negative. */
function reviewAgeOf(review: Review | typeof REVIEW_UNKNOWN | undefined, asOf: Date | undefined): number | "unknown" {
  if (review === undefined || review === REVIEW_UNKNOWN || asOf === undefined) return "unknown";
  const date = new Date(review.date);
  if (Number.isNaN(date.getTime())) return "unknown";
  return Math.max(0, Math.floor((asOf.getTime() - date.getTime()) / DAY));
}

/** The evidence states for the signals the entry builder was given. */
function evidenceOf(signals: TrustSignals): TrustEvidence {
  const examples: TrustEvidence["examples"] =
    signals.examples === "unknown" ? "unknown" : signals.examples === undefined ? "none" : "measured";
  const drift: TrustEvidence["drift"] =
    signals.drift === undefined ? (signals.driftState ?? "missing") : "measured";
  const review: TrustEvidence["review"] =
    signals.review === undefined || signals.review === REVIEW_UNKNOWN
      ? (signals.reviewState ?? "missing")
      : "measured";
  return { examples, drift, review };
}

/** One entry, with `lastReviewer` present only when it is known. */
function entryOf(
  evidence: TrustEvidence,
  level: TrustLevel,
  reasons: readonly TrustEntryReason[],
  lastReviewer: string,
): TrustEntry {
  return lastReviewer === "" ? { evidence, level, reasons } : { evidence, level, reasons, lastReviewer };
}

/**
 * The pure core: N12's score plus the one case N12 cannot see, a page whose examples were never
 * measured. That case replaces the examples reason with `examples.unknown` and makes the page
 * `at-risk`, so an unknown result is never written as `verified`. Everything else comes from
 * {@link trustScore}, including the fixed reason order and the review threshold.
 */
export function trustEntryOf(signals: TrustSignals, options: TrustScoreOptions = {}): TrustEntry {
  const measured = signals.examples === "unknown" ? undefined : signals.examples;
  const score = trustScore(
    {
      ...(measured === undefined ? {} : { examples: measured }),
      ...(signals.drift === undefined ? {} : { drift: signals.drift }),
      reviewAgeDays: reviewAgeOf(signals.review, signals.asOf),
    },
    options,
  );

  const evidence = evidenceOf(signals);
  const lastReviewer =
    signals.review === undefined || signals.review === REVIEW_UNKNOWN ? "" : signals.review.author.trim();

  if (signals.examples !== "unknown") return entryOf(evidence, score.level, score.reasons, lastReviewer);

  const unknownExamples: TrustEntryReason = {
    code: "examples.unknown",
    message: "The example results are unknown, so the page cannot be verified.",
  };
  const reasons: readonly TrustEntryReason[] = [unknownExamples, score.reasons[1]!, score.reasons[2]!];
  return entryOf(evidence, "at-risk", reasons, lastReviewer);
}

/** A page's stable key, from the two facts that identify it: its URL and its source file. */
function pageKeyOf(page: Page): string {
  return hashOf(`${page.url}\0${page.source.file}`);
}

/** The build identifier: one line per rendered page, sorted by URL, over the page's identity and content. */
function buildIdOf(pages: readonly Page[]): string {
  return hashOf(
    pages
      .map((page) => `${pageKeyOf(page)}\0${hashOf(page.markdown)}\0${hashOf(page.html)}\n`)
      .join(""),
  );
}

/**
 * The root the output uses when no option names one: `MIZZEN_SITE_ROOT` when set, otherwise the process's
 * working directory. The caller can pass a fresh environment to test the rule without touching the process.
 */
export function trustRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[SITE_ROOT_ENV]?.trim() ?? "";
  return value === "" ? process.cwd() : value;
}

/**
 * The `asOf` the output uses when no option names one: `SOURCE_DATE_EPOCH` in whole seconds, or
 * `undefined` when it is unset or not a non-negative integer. The clock is never read.
 */
export function trustAsOf(env: NodeJS.ProcessEnv = process.env): Date | undefined {
  const value = env[AS_OF_ENV]?.trim() ?? "";
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** True when a doc page declares at least one `test` fence, so missing example data means unknown, not none. */
async function declaresExamples(page: Page): Promise<boolean> {
  if (!page.markdown.includes("test")) return false;
  try {
    return (await examplesOf(page)).length > 0;
  } catch {
    // A page whose body cannot be read for fences is treated as possibly having examples, never as none.
    return true;
  }
}

/** The drift finding count per page URL, from {@link compareClaims}; `undefined` when the check cannot run. */
async function driftCountsOf(pages: readonly Page[], root: string): Promise<Map<string, number> | undefined> {
  try {
    const diagnostics = await compareClaims(pages, { root });
    const byFile = new Map<string, number>();
    for (const diagnostic of diagnostics) {
      const file = diagnostic.pos?.file;
      if (file === undefined) continue;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }
    const byUrl = new Map<string, number>();
    for (const page of pages) byUrl.set(page.url, byFile.get(page.source.file) ?? 0);
    return byUrl;
  } catch {
    return undefined;
  }
}

/**
 * Builds `trust.json` from the site model and the available data. Doc pages only, sorted by URL. This is
 * the helper tests call: it takes `root`, `asOf`, and the data inline, and reads no environment itself.
 */
export async function trustReport(site: Site, options: TrustReportOptions = {}): Promise<readonly OutputFile[]> {
  const pages = site.pages
    .filter((page) => page.kind === "doc")
    .slice()
    .sort((a, b) => byCodePoint(a.url, b.url));

  const examples = examplesIndexOf(options.examples ?? site.data.examples);
  const driftData = driftIndexOf(options.drift ?? site.data.drift);
  const reviewData = reviewIndexOf(options.reviewers ?? site.data.reviewers);
  const asOf = asOfOf(options.asOf);
  const root = options.root;

  const driftCounts =
    root !== undefined && pages.some((page) => !driftData.has(page.url))
      ? await driftCountsOf(pages, root)
      : undefined;

  const body: Record<string, TrustPageEntry> = {};
  for (const page of pages) {
    const measured = examples.get(page.url);
    const examplesSignal: TrustExamples | "unknown" | undefined =
      measured !== undefined ? measured : (await declaresExamples(page)) ? "unknown" : undefined;

    const drift = driftData.get(page.url) ?? driftCounts?.get(page.url);
    const review = reviewData.get(page.url) ?? (root === undefined ? REVIEW_UNKNOWN : reviewers(root, page.source.file));

    const signals: TrustSignals = {
      ...(examplesSignal === undefined ? {} : { examples: examplesSignal }),
      ...(drift === undefined ? {} : { drift }),
      review,
      ...(asOf === undefined ? {} : { asOf }),
      // A root means the check could have run; without one, the signal was never available at all.
      ...(drift === undefined ? { driftState: root === undefined ? "missing" : "unknown" } : {}),
      ...(review === REVIEW_UNKNOWN ? { reviewState: root === undefined ? "missing" : "unknown" } : {}),
    };
    const entry = trustEntryOf(signals, options.thresholds === undefined ? {} : { thresholds: options.thresholds });
    body[page.url] = {
      key: pageKeyOf(page),
      url: page.url,
      source: page.source.file,
      evidence: entry.evidence,
      level: entry.level,
      reasons: entry.reasons,
      ...(entry.lastReviewer === undefined ? {} : { lastReviewer: entry.lastReviewer }),
    };
  }

  const report: TrustReport = {
    version: TRUST_VERSION,
    build: { algorithm: "sha256", id: buildIdOf(pages), pages: pages.length },
    pages: body,
  };
  return [{ path: "trust.json", contents: `${JSON.stringify(report, null, 2)}\n` }];
}

/**
 * The output that writes `trust.json`. Its root comes from `MIZZEN_SITE_ROOT` (or the working directory)
 * and its `asOf` from `SOURCE_DATE_EPOCH`; see the module comment for the shape and the data channels.
 */
export const trust: Output = {
  name: "trust",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const asOf = trustAsOf();
    return trustReport(site, {
      root: trustRoot(),
      ...(asOf === undefined ? {} : { asOf }),
    });
  },
};
