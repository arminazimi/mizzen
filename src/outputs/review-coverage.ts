import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { repositoryState, reviewHistory, type PageReviewHistory, type ReviewCommit } from "../model/reviewers.ts";
import {
  policyFor,
  resolveReviewPolicy,
  reviewPolicyValue,
  type MatchedReviewPolicy,
  type ReviewPolicy,
  type ReviewPolicyDiagnostic,
  type ReviewPolicyRule,
} from "../model/review-policy.ts";
import { hashOf } from "./build-hash.ts";
import { trustAsOf, trustRoot } from "./trust.ts";

/**
 * Writes `review-coverage.json`: one entry per doc page with the page's review policy, the commits inside
 * its window, the distinct mailmap authors, the last review, and a state a maintainer can act on (N65).
 *
 * ## Shape
 *
 * ```json
 * {
 *   "version": 1,
 *   "asOf": "2026-11-11T00:00:00.000Z",
 *   "policy": {
 *     "default": { "windowDays": 180, "minReviewers": 1 },
 *     "rules": [{ "path": "guide/security", "windowDays": 30, "minReviewers": 2 }]
 *   },
 *   "diagnostics": [],
 *   "pages": {
 *     "/guide/security/keys/": {
 *       "key": "…64 hex…",
 *       "url": "/guide/security/keys/",
 *       "source": "guide/security/keys.md",
 *       "policy": { "windowDays": 30, "minReviewers": 2, "path": "guide/security" },
 *       "state": "satisfied",
 *       "lastReview": { "date": "2026-11-01T00:00:00.000Z", "author": "Ada Lovelace" },
 *       "reviewers": ["Ada Lovelace", "Grace Hopper"],
 *       "commits": [
 *         { "date": "2026-11-01T00:00:00.000Z", "author": "Ada Lovelace" },
 *         { "date": "2026-10-20T00:00:00.000Z", "author": "Grace Hopper" }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * The file is one object with `version`, `asOf`, `policy`, `diagnostics`, and `pages`, in that order.
 * Pages are keyed by URL, including `base`, in code-point order. Each entry repeats the stable page `key`
 * `trust.json` uses (SHA-256 of the URL, a NUL, and the source file), its `url` and `source`, the matched
 * `policy`, and then the evidence.
 *
 * `lastReview` is the last commit that ever named the page, even when it is older than the window. It is
 * absent when the page is untracked, unavailable, or has no as-of. `commits` is every commit inside the
 * page's own window, newest first, and `reviewers` is the distinct mailmap author names among those
 * commits, in code-point order. Repeated commits by one author count once, and two `.mailmap` aliases for
 * one person count once; a name that never appears in `.mailmap` is its own identity.
 *
 * ## States
 *
 * - `satisfied`: the last review is inside the window and at least `minReviewers` distinct reviewers
 *   touched the page inside it.
 * - `insufficient`: the last review is inside the window but fewer than `minReviewers` distinct reviewers
 *   did.
 * - `overdue`: a commit names the page, but the last one is outside the window (including a commit dated
 *   after the as-of; a review that cannot be placed inside the window never passes).
 * - `untracked`: the root is a work tree, but no commit names the page.
 * - `unavailable`: git, a work tree, a confined path, or the bounded history read is missing.
 * - `no-as-of`: no usable as-of was supplied, so no window can be measured. This wins even when git is
 *   also unavailable, because the report cannot say anything about freshness without an as-of.
 *
 * No unknown is ever `satisfied`: untracked, unavailable, and no-as-of all have an empty `reviewers` and
 * `commits`, and an overdue page has its old `lastReview` and no commits in the window.
 *
 * ## Policy
 *
 * The policy comes from `_data/review-policy.yml` (`site.data["review-policy"]`, also readable as
 * `site.data.reviewPolicy`) and is resolved by N65's {@link resolveReviewPolicy}: most-specific path wins,
 * a later rule wins a tie, a rule inherits the default field it leaves out, and an invalid rule is ignored
 * and reported. Each page names the rule path that matched it, or `null` for the default. Invalid policy
 * findings are written to `diagnostics` and also reported through `ctx.report` as warnings, so they never
 * silently change a required review.
 *
 * ## As-of and root
 *
 * `asOf` is the caller's option, or `SOURCE_DATE_EPOCH` (seconds since the Unix epoch) when the output
 * runs itself. Nothing reads the clock: without either, every page is `no-as-of` and git is not read.
 * `OutputContext` has no root, so the output reads `MIZZEN_SITE_ROOT` and falls back to the process's
 * working directory; the exported helper takes `root` as an option instead.
 *
 * The report reads one bounded `git log` per root, covering the widest window any page asks for, and
 * filters it per page in memory. A page with no commit in that window asks the existing per-root
 * last-commit cache whether any commit ever names it, so an old page is distinguished from an untracked
 * one without a per-page history read.
 *
 * ## Determinism
 *
 * Pages are sorted by URL, commits newest first (then by author), reviewers by code point, and rules in
 * declaration order. The JSON uses two-space indentation, a fixed key order, and one trailing LF. For a
 * fixed site model, root, history, policy, and as-of, two runs write the same bytes. `trust.json` is not
 * read or changed by this output.
 */

/** The shape version of `review-coverage.json`. */
export const REVIEW_COVERAGE_VERSION = 1;

/** Milliseconds in a whole day. */
const DAY = 86_400_000;

/** How a page's review coverage stands against its policy. */
export type ReviewCoverageState = "satisfied" | "insufficient" | "overdue" | "untracked" | "unavailable" | "no-as-of";

/** The policy a page was evaluated against, and the rule path that selected it. */
export type ReviewCoveragePolicy = MatchedReviewPolicy;

/** One page's evidence in `review-coverage.json`, in key order. */
export interface ReviewCoverageEntry {
  /** Stable page key: SHA-256 of the URL, a NUL, and the source file, the same key `trust.json` uses. */
  readonly key: string;
  /** Output URL, including `base`. */
  readonly url: string;
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
  /** The matched policy and the rule path that selected it. */
  readonly policy: ReviewCoveragePolicy;
  /** How the page stands against its policy. */
  readonly state: ReviewCoverageState;
  /** The last commit that ever named the page, even outside the window; absent when none is known. */
  readonly lastReview?: ReviewCommit;
  /** Distinct mailmap author names inside the window, in code-point order. */
  readonly reviewers: readonly string[];
  /** Commits inside the window, newest first. */
  readonly commits: readonly ReviewCommit[];
}

/** The resolved policy the report was evaluated with. */
export interface ReviewCoveragePolicyReport {
  /** The policy for a page no rule matches. */
  readonly default: ReviewPolicy;
  /** The valid rules, in declaration order. */
  readonly rules: readonly ReviewPolicyRule[];
}

/** The whole `review-coverage.json` body, in key order. */
export interface ReviewCoverageReport {
  readonly version: typeof REVIEW_COVERAGE_VERSION;
  /** The explicit as-of in UTC ISO 8601, or `null` when none was supplied. */
  readonly asOf: string | null;
  /** The resolved policy. */
  readonly policy: ReviewCoveragePolicyReport;
  /** Every invalid policy finding, in discovery order. */
  readonly diagnostics: readonly ReviewPolicyDiagnostic[];
  /** One entry per doc page, keyed by URL in code-point order. */
  readonly pages: Readonly<Record<string, ReviewCoverageEntry>>;
}

/** Options of {@link reviewCoverageReport}; every field has a default. */
export interface ReviewCoverageOptions {
  /** Site root for the git history. Default: no root, so every page with an as-of is `unavailable`. */
  readonly root?: string;
  /** The instant the window ends: a `Date` or an ISO 8601 string. Default: unknown, so every page is `no-as-of`. */
  readonly asOf?: Date | string;
  /** The raw policy value. Default: `site.data["review-policy"]`, then `site.data.reviewPolicy`. */
  readonly policy?: unknown;
  /** Called once for each invalid policy finding. The output passes `ctx.report`; tests may collect them. */
  readonly report?: (diagnostic: Diagnostic) => void;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The instant an option asks for, or `undefined` when it is absent or not a date. */
function asOfOf(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The instant of a canonical commit date, or `undefined` when it does not parse. */
function instantOf(date: string): number | undefined {
  const instant = Date.parse(date);
  return Number.isNaN(instant) ? undefined : instant;
}

/** The distinct author names of a commit list, in code-point order. */
function reviewersOf(commits: readonly ReviewCommit[]): readonly string[] {
  return [...new Set(commits.map((commit) => commit.author))].sort(byCodePoint);
}

/** A page's stable key, the same SHA-256 of URL, NUL, and source that `trust.json` uses. */
function pageKeyOf(page: Page): string {
  return hashOf(`${page.url}\0${page.source.file}`);
}

/** `commits` filtered to the page's own window; the broad read may cover a longer default window. */
function commitsInWindow(commits: readonly ReviewCommit[], since: number, until: number): readonly ReviewCommit[] {
  return commits.filter((commit) => {
    const instant = instantOf(commit.date);
    return instant !== undefined && instant >= since && instant <= until;
  });
}

/** The state of one page, from its history, policy, and as-of. */
function stateOf(
  history: PageReviewHistory,
  policy: ReviewCoveragePolicy,
  asOf: number,
  commits: readonly ReviewCommit[],
  reviewers: readonly string[],
): ReviewCoverageState {
  if (history.coverage === "unavailable") return "unavailable";
  if (history.coverage === "untracked") return "untracked";

  const last = history.lastReview;
  if (last === undefined) return "unavailable";
  const lastInstant = instantOf(last.date);
  const since = asOf - policy.windowDays * DAY;
  if (lastInstant === undefined || lastInstant < since || lastInstant > asOf) return "overdue";
  return reviewers.length >= policy.minReviewers && commits.length > 0 ? "satisfied" : "insufficient";
}

/**
 * Builds `review-coverage.json` from the site model, the policy, and git history. Doc pages only, sorted
 * by URL. This is the helper tests call: it takes `root`, `asOf`, and the policy inline, and reads no
 * environment itself. Without an as-of it does not read git at all.
 */
export async function reviewCoverageReport(
  site: Site,
  options: ReviewCoverageOptions = {},
): Promise<readonly OutputFile[]> {
  const pages = site.pages
    .filter((page) => page.kind === "doc")
    .slice()
    .sort((a, b) => byCodePoint(a.url, b.url));

  const policyValue = options.policy === undefined ? reviewPolicyValue(site.data) : options.policy;
  const resolution = resolveReviewPolicy(policyValue);
  for (const diagnostic of resolution.diagnostics) {
    options.report?.({ id: diagnostic.code, severity: "warning", message: diagnostic.message });
  }

  const asOf = asOfOf(options.asOf);
  const asOfInstant = asOf?.getTime();
  const matched = new Map<string, ReviewCoveragePolicy>();
  for (const page of pages) matched.set(page.url, policyFor(resolution, page.source.file));

  // One read covers every page: start at the earliest window any matched policy asks for.
  let earliest: number | undefined;
  if (asOfInstant !== undefined) {
    for (const policy of matched.values()) {
      const since = asOfInstant - policy.windowDays * DAY;
      earliest = earliest === undefined ? since : Math.min(earliest, since);
    }
  }

  const body: Record<string, ReviewCoverageEntry> = {};
  // One state for every page: reviewHistory would otherwise spawn one git process per page. A missing as-of reads no
  // history, so it must not read git either.
  const repoState =
    asOfInstant === undefined || options.root === undefined ? undefined : repositoryState(options.root);
  for (const page of pages) {
    const policy = matched.get(page.url)!;
    const base = {
      key: pageKeyOf(page),
      url: page.url,
      source: page.source.file,
      policy,
    };

    if (asOfInstant === undefined) {
      body[page.url] = { ...base, state: "no-as-of", reviewers: [], commits: [] };
      continue;
    }
    if (options.root === undefined) {
      body[page.url] = { ...base, state: "unavailable", reviewers: [], commits: [] };
      continue;
    }

    const history = reviewHistory(options.root, page.source.file, {
      since: new Date(earliest!),
      until: asOf!,
    }, repoState);
    const since = asOfInstant - policy.windowDays * DAY;
    const commits = commitsInWindow(history.commits, since, asOfInstant);
    const reviewerNames = reviewersOf(commits);
    const state = stateOf(history, policy, asOfInstant, commits, reviewerNames);
    const lastReview = history.lastReview;

    body[page.url] = {
      ...base,
      state,
      ...(lastReview === undefined ? {} : { lastReview }),
      reviewers: reviewerNames,
      commits,
    };
  }

  const report: ReviewCoverageReport = {
    version: REVIEW_COVERAGE_VERSION,
    asOf: asOf?.toISOString() ?? null,
    policy: { default: resolution.default, rules: resolution.rules },
    diagnostics: resolution.diagnostics,
    pages: body,
  };
  return [{ path: "review-coverage.json", contents: `${JSON.stringify(report, null, 2)}\n` }];
}

/**
 * The output that writes `review-coverage.json`. Its root comes from `MIZZEN_SITE_ROOT` (or the working
 * directory) and its as-of from `SOURCE_DATE_EPOCH`; see the module comment for the shape and the states.
 * A page no rule matches uses the default policy, so adding a sensitive rule changes only that path.
 */
export const reviewCoverage: Output = {
  name: "review-coverage",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const asOf = trustAsOf();
    return reviewCoverageReport(site, {
      root: trustRoot(),
      ...(asOf === undefined ? {} : { asOf }),
      report: (diagnostic) => ctx.report(diagnostic),
    });
  },
};
