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

/**
 * Writes `trust.json`: one entry per doc page, keyed by its URL, with the page's trust level, the
 * reasons behind it, and the last reviewer (N14). A theme can render its trust chip from this file.
 *
 * ## Shape
 *
 * The file is one JSON object. Every key is a page URL, including the site's `base`, and the keys come
 * in code-point order. Each entry has a fixed key order:
 *
 * ```json
 * {
 *   "/guide/install/": {
 *     "level": "verified",
 *     "reasons": [
 *       { "code": "examples.passed", "message": "No example fails; 2 of 2 pass." },
 *       { "code": "drift.clean", "message": "No drift findings." },
 *       { "code": "review.recent", "message": "Last reviewed 9 days ago, within the 180-day limit." }
 *     ],
 *     "lastReviewer": "Ada Lovelace"
 *   }
 * }
 * ```
 *
 * `level` is `verified`, `review-due`, or `at-risk`, exactly as N12's {@link trustScore} decides.
 * `reasons` always has three entries, in the fixed order examples, drift, review. `lastReviewer` is
 * present only when the last commit that touched the page has a non-empty author name. The JSON uses
 * two-space indentation and one trailing LF, and `schema/trust.schema.json` describes the same shape.
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

/** One page's entry in `trust.json`, in key order. */
export interface TrustEntry {
  /** The worst level the reasons support. */
  readonly level: TrustLevel;
  /** Exactly three reasons, ordered examples, drift, review. */
  readonly reasons: readonly TrustEntryReason[];
  /** The last commit's author name, when it is known. */
  readonly lastReviewer?: string;
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

/** Compares by code point, never by locale (ADR 0022, rule 5). */
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

/** One entry, with `lastReviewer` present only when it is known. */
function entryOf(level: TrustLevel, reasons: readonly TrustEntryReason[], lastReviewer: string): TrustEntry {
  return lastReviewer === "" ? { level, reasons } : { level, reasons, lastReviewer };
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

  const lastReviewer =
    signals.review === undefined || signals.review === REVIEW_UNKNOWN ? "" : signals.review.author.trim();

  if (signals.examples !== "unknown") return entryOf(score.level, score.reasons, lastReviewer);

  const unknownExamples: TrustEntryReason = {
    code: "examples.unknown",
    message: "The example results are unknown, so the page cannot be verified.",
  };
  const reasons: readonly TrustEntryReason[] = [unknownExamples, score.reasons[1]!, score.reasons[2]!];
  return entryOf("at-risk", reasons, lastReviewer);
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

  const body: Record<string, TrustEntry> = {};
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
    };
    body[page.url] = trustEntryOf(signals, options.thresholds === undefined ? {} : { thresholds: options.thresholds });
  }

  return [{ path: "trust.json", contents: `${JSON.stringify(body, null, 2)}\n` }];
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
