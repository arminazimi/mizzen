/**
 * Trust score (N12): one explainable level per page from its example results, its drift findings, and how
 * long ago it was reviewed.
 *
 * The model reads nothing on its own. It is a pure function of its argument, so the same input always
 * gives the same output, in the same reason order. The review age is passed in, never
 * read from the clock: the caller that has git history or a review date decides how many whole days old
 * it is, or passes `"unknown"` when it cannot tell.
 *
 * A page is `verified` only when every signal is healthy. The signals and their thresholds are:
 *
 * - **Examples.** A failing example makes a page `at-risk`: passing examples can never outweigh a
 *   failure, and no option can raise that threshold above zero, because a page whose recorded output
 *   does not run is not trustworthy. A page that declares no runnable examples is not penalized.
 * - **Drift.** Any drift finding makes a page `at-risk`. A missing drift count is not the same as zero:
 *   an unchecked page cannot be confirmed to match the code, so it is `at-risk` too.
 * - **Review age.** More than {@link DEFAULT_REVIEW_DUE_DAYS} days (180) since the last review makes a
 *   page `review-due`. An unknown age also makes it `review-due`: it cannot be shown to be fresh, but
 *   nothing is known to be wrong. The threshold is the one setting: pass
 *   `{ thresholds: { reviewDueDays } }` to change it. It is not a config key, so the frozen site config
 *   schema is untouched.
 *
 * The worst signal sets the level (`at-risk` beats `review-due` beats `verified`). Every signal still
 * contributes one reason, so a maintainer sees both what is wrong and what is fine. Reasons always come
 * in the same order: examples, then drift, then review.
 *
 * Limits: the inputs are counts and an age, not page positions, so reasons carry no source position. The
 * drift and example checks report their own findings where they occur.
 */

/** The default number of days a review stays fresh: 180. */
export const DEFAULT_REVIEW_DUE_DAYS = 180;

/** How much a page can be trusted, worst last. */
export type TrustLevel = "verified" | "review-due" | "at-risk";

/** A page's example counts, as `examples.json` records them for one page. */
export interface TrustExamples {
  /** Every `test` fence on the page, including ones that were not run. */
  readonly total: number;
  /** The examples that passed. */
  readonly passed: number;
  /** The examples that failed. Anything above zero makes the page `at-risk`. */
  readonly failed: number;
}

/** Everything the model looks at. Every field is optional, and an absent signal is never assumed healthy. */
export interface TrustScoreInput {
  /**
   * The page's example counts. Absent means the page declares no runnable examples, which is not held
   * against it; present with a failing count makes the page `at-risk` whatever the other signals say.
   */
  readonly examples?: TrustExamples;
  /**
   * The page's drift finding count. Zero is clean; above zero is `at-risk`. Absent, negative, or not a
   * finite number means drift was not checked, which is also `at-risk`: an unchecked page cannot be
   * verified.
   */
  readonly drift?: number;
  /**
   * Whole days since the page was last reviewed, or `"unknown"` when that cannot be told. Omitted is
   * treated as `"unknown"`; a negative or non-finite number is treated as zero. Defaults to unknown.
   */
  readonly reviewAgeDays?: number | "unknown";
}

/** The settings a maintainer may change. Each has a documented default. */
export interface TrustThresholds {
  /**
   * Days a review stays fresh. Default {@link DEFAULT_REVIEW_DUE_DAYS} (180). A page older than this is
   * `review-due`; exactly this many days is still fresh. A negative value is treated as zero, and a
   * non-finite value is ignored in favour of the default.
   */
  readonly reviewDueDays?: number;
}

/** Options of {@link trustScore}. */
export interface TrustScoreOptions {
  /** The thresholds to use instead of the defaults. */
  readonly thresholds?: TrustThresholds;
}

/** The code of one reason, which also tells whether it is good news or bad. */
export type TrustReasonCode =
  | "examples.none"
  | "examples.passed"
  | "examples.failed"
  | "drift.clean"
  | "drift.findings"
  | "drift.unknown"
  | "review.recent"
  | "review.overdue"
  | "review.unknown";

/** One readable piece of evidence behind a level. */
export interface TrustReason {
  /** A stable identifier; the same finding always has the same code. */
  readonly code: TrustReasonCode;
  /** The sentence a maintainer reads to see what the code found. */
  readonly message: string;
}

/** A page's level and every reason behind it, in a fixed order. */
export interface TrustScore {
  /** The worst level the reasons support. */
  readonly level: TrustLevel;
  /** Exactly one reason for examples, one for drift, and one for review, in that order. */
  readonly reasons: readonly TrustReason[];
}

/** A count as a whole, non-negative number; a negative or non-finite one is treated as zero. */
function countOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  const count = Math.trunc(value);
  return count < 0 ? 0 : count;
}

/** A whole, non-negative day count; a negative or non-finite one is treated as zero. */
function daysOf(value: number): number {
  return countOf(value);
}

/** An English plural suffix for a count. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * The review-due threshold in whole days: the caller's option when it is finite, never negative, and
 * otherwise {@link DEFAULT_REVIEW_DUE_DAYS}. The default applies to an absent, non-finite, or negative
 * value; zero is a valid threshold and means every page is due the day after it is reviewed.
 */
export function reviewDueDaysOf(options: TrustScoreOptions = {}): number {
  const value = options.thresholds?.reviewDueDays;
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_REVIEW_DUE_DAYS;
  return Math.trunc(value);
}

/** The example reason: a failure is at-risk, some examples passing is good, none declared is neutral. */
function exampleReason(examples: TrustExamples | undefined): {
  readonly level: TrustLevel;
  readonly reason: TrustReason;
} {
  const total = countOf(examples?.total);
  const passed = countOf(examples?.passed);
  const failed = countOf(examples?.failed);

  if (failed > 0) {
    return {
      level: "at-risk",
      reason: { code: "examples.failed", message: `${failed} of ${total} example${plural(total)} fail.` },
    };
  }
  if (total > 0) {
    return {
      level: "verified",
      reason: { code: "examples.passed", message: `No example fails; ${passed} of ${total} pass.` },
    };
  }
  return {
    level: "verified",
    reason: { code: "examples.none", message: "The page declares no runnable examples." },
  };
}

/** The drift reason: findings are at-risk, zero is clean, and an absent count is unverified. */
function driftReason(drift: number | undefined): { readonly level: TrustLevel; readonly reason: TrustReason } {
  if (drift === undefined || !Number.isFinite(drift) || drift < 0) {
    return {
      level: "at-risk",
      reason: {
        code: "drift.unknown",
        message: "Drift was not checked, so the page cannot be verified.",
      },
    };
  }
  const findings = Math.trunc(drift);
  if (findings > 0) {
    return {
      level: "at-risk",
      reason: {
        code: "drift.findings",
        message: `${findings} drift finding${plural(findings)}: the page no longer matches the code it cites.`,
      },
    };
  }
  return { level: "verified", reason: { code: "drift.clean", message: "No drift findings." } };
}

/** The review reason: a recent review is good, an old or unknown one needs attention. */
function reviewReason(
  reviewAgeDays: number | "unknown" | undefined,
  reviewDueDays: number,
): { readonly level: TrustLevel; readonly reason: TrustReason } {
  if (reviewAgeDays === undefined || reviewAgeDays === "unknown" || !Number.isFinite(reviewAgeDays)) {
    return {
      level: "review-due",
      reason: {
        code: "review.unknown",
        message: "The review age is unknown, so the page cannot be confirmed as reviewed.",
      },
    };
  }
  const age = daysOf(reviewAgeDays);
  if (age > reviewDueDays) {
    return {
      level: "review-due",
      reason: {
        code: "review.overdue",
        message: `Last reviewed ${age} day${plural(age)} ago, past the ${reviewDueDays}-day limit.`,
      },
    };
  }
  return {
    level: "verified",
    reason: {
      code: "review.recent",
      message: `Last reviewed ${age} day${plural(age)} ago, within the ${reviewDueDays}-day limit.`,
    },
  };
}

/** The worse of two levels, with `at-risk` worst and `verified` best. */
function worse(a: TrustLevel, b: TrustLevel): TrustLevel {
  const rank: Readonly<Record<TrustLevel, number>> = { verified: 0, "review-due": 1, "at-risk": 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Combines example results, drift findings, and review age into one trust level plus the reasons behind
 * it. The rules and their defaults are in the module comment; the review threshold is overridable with
 * `{ thresholds: { reviewDueDays } }`, and no option can let a failing example or a drift finding pass.
 *
 * The result depends only on the argument: no clock, filesystem, network, or environment is read, and
 * reasons come in the fixed order examples, drift, review. A page with one failing example is
 * `at-risk` in every case.
 */
export function trustScore(input: TrustScoreInput, options: TrustScoreOptions = {}): TrustScore {
  const reviewDueDays = reviewDueDaysOf(options);
  const examples = exampleReason(input.examples);
  const drift = driftReason(input.drift);
  const review = reviewReason(input.reviewAgeDays, reviewDueDays);

  return {
    level: worse(worse(examples.level, drift.level), review.level),
    reasons: [examples.reason, drift.reason, review.reason],
  };
}
