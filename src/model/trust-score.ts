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
 *   does not run is not trustworthy. A declared set whose outcomes do not account for every example is
 *   incomplete evidence, also `at-risk`: the examples that never ran cannot pass. A page that declares
 *   no runnable examples is not penalized.
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
 * Each signal also returns a machine-readable {@link TrustFactor}. A factor carries the same stable code, one
 * state, and the measured value, and no sentence, so a consumer can branch on data while the wording stays in
 * the reasons. Reviewer coverage is reported separately as {@link TrustScore.reviewCoverage}, so a page with no
 * recorded review is not mistaken for one that was merely reviewed long ago.
 *
 * Conflicting evidence never resolves towards a healthy page. Example or drift counts that are not whole,
 * finite, non-negative safe integers, example counts that cannot all hold, a supplied review age that the
 * coverage contradicts, and a review dated after the measured instant make the page `at-risk` or `review-due`,
 * never `verified`. Malformed counts are reported as the conflict or missing signal they are; they are never
 * repaired to a smaller non-negative count.
 *
 * Limits: the inputs are counts and an age, not page positions, so reasons carry no source position. The
 * drift and example checks report their own findings where they occur.
 */

import type { ReviewCoverage } from "./reviewers.ts";

/** The default number of days a review stays fresh: 180. */
export const DEFAULT_REVIEW_DUE_DAYS = 180;

/** How much a page can be trusted, worst last. */
export type TrustLevel = "verified" | "review-due" | "at-risk";

/**
 * A page's example counts, as `examples.json` records them for one page. Every count must be a whole,
 * finite, non-negative safe integer; a count that is not is malformed evidence, reported as a conflict
 * and never repaired to zero.
 */
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
   * against it; present with a failing count makes the page `at-risk` whatever the other signals say, and
   * present with a count that is not a whole, finite, non-negative safe integer is conflicting evidence.
   */
  readonly examples?: TrustExamples;
  /**
   * The page's drift finding count. Zero is clean; above zero is `at-risk`. Anything else the caller
   * supplies — absent, negative, fractional, non-finite, or beyond a safe integer — means drift was not
   * checked, which is also `at-risk`: an unchecked page cannot be verified. A fractional count is never
   * truncated into either a clean zero or a finding.
   */
  readonly drift?: number;
  /**
   * Whole days since the page was last reviewed, or `"unknown"` when that cannot be told. Omitted or a
   * non-finite number is treated as `"unknown"`. A negative age is a review dated after the measured instant,
   * which cannot be confirmed, so it is reported as a conflict and is `review-due`.
   */
  readonly reviewAgeDays?: number | "unknown";
  /**
   * What git knows about the page's review, when the caller asked. Absent is derived from the age: a known age
   * means a `recorded` review, an unknown age leaves the coverage `unknown`. `untracked` or `unavailable`
   * together with a known age is conflicting evidence, and the age cannot make the page `verified`.
   */
  readonly reviewCoverage?: ReviewCoverage;
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
  | "examples.incomplete"
  | "examples.conflict"
  | "drift.clean"
  | "drift.findings"
  | "drift.unknown"
  | "review.recent"
  | "review.overdue"
  | "review.unknown"
  | "review.conflict";

/** The signal a factor measures, in the fixed reason order. */
export type TrustSignal = "examples" | "drift" | "review";

/**
 * What a signal's evidence says: `positive` supports trust, `neutral` has nothing to judge, `missing` could not
 * be checked, `negative` shows a problem, and `conflict` contradicts itself.
 */
export type TrustFactorState = "positive" | "neutral" | "negative" | "missing" | "conflict";

/** One readable piece of evidence behind a level. */
export interface TrustReason {
  /** A stable identifier; the same finding always has the same code. */
  readonly code: TrustReasonCode;
  /** The sentence a maintainer reads to see what the code found. */
  readonly message: string;
}

/**
 * One signal as data, with no sentence. Consumers branch on `code` or `state` instead of parsing a message, so
 * the scoring policy stays independent of any presentation.
 */
export interface TrustFactor {
  /** Which signal this is; factors come in the fixed order examples, drift, review. */
  readonly signal: TrustSignal;
  /** The same stable code as the matching reason. */
  readonly code: TrustReasonCode;
  /** Whether the evidence is good, absent, bad, or contradictory. */
  readonly state: TrustFactorState;
  /**
   * The measured value, or `"unknown"` when the signal was not measured: failing examples for examples, findings
   * for drift, and whole days for review.
   */
  readonly value: number | "unknown";
}

/** A page's level, every reason behind it, and the same signals as data, in a fixed order. */
export interface TrustScore {
  /** The worst level the reasons support. */
  readonly level: TrustLevel;
  /** Exactly one reason for examples, one for drift, and one for review, in that order. */
  readonly reasons: readonly TrustReason[];
  /** One factor per reason, in the same fixed order, with no presentation. */
  readonly factors: readonly TrustFactor[];
  /** What is known about the reviewer: `recorded`, `untracked`, `unavailable`, or `unknown` when not looked up. */
  readonly reviewCoverage: ReviewCoverage | "unknown";
}

/** One signal's level, reason, and factor, so the three views are decided once. */
interface SignalVerdict {
  readonly level: TrustLevel;
  readonly state: TrustFactorState;
  readonly value: number | "unknown";
  readonly reason: TrustReason;
}

/**
 * True when a supplied count is evidence at all: a whole, finite, non-negative safe integer. A fractional,
 * negative, NaN, infinite, or unsafe value is malformed and is never repaired by truncation or clamping.
 */
function isWholeCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** How a supplied count reads in a message, malformed values included. */
function countText(value: number | undefined): string {
  return value === undefined ? "none" : String(value);
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
function exampleVerdict(examples: TrustExamples | undefined): SignalVerdict {
  // Declaring no examples at all is genuinely absent evidence, held against no page.
  if (examples === undefined) {
    return {
      level: "verified",
      state: "neutral",
      value: "unknown",
      reason: { code: "examples.none", message: "The page declares no runnable examples." },
    };
  }
  const { total, passed, failed } = examples;

  // A supplied count that is not a whole, finite, non-negative safe integer is malformed evidence. It is
  // never truncated or clamped into a passing or failing count: the whole measurement is refused.
  if (!isWholeCount(total) || !isWholeCount(passed) || !isWholeCount(failed)) {
    return {
      level: "at-risk",
      state: "conflict",
      value: "unknown",
      reason: {
        code: "examples.conflict",
        message:
          `The example counts are not whole non-negative counts ` +
          `(${countText(passed)} pass and ${countText(failed)} fail of ${countText(total)}), ` +
          `so the page cannot be verified.`,
      },
    };
  }

  // Counts that cannot all hold cannot confirm anything: neither the passes nor the failures are trusted.
  if (passed + failed > total) {
    return {
      level: "at-risk",
      state: "conflict",
      value: failed,
      reason: {
        code: "examples.conflict",
        message: `The example counts disagree: ${passed} pass and ${failed} fail of ${total}, so the page cannot be verified.`,
      },
    };
  }
  if (failed > 0) {
    return {
      level: "at-risk",
      state: "negative",
      value: failed,
      reason: { code: "examples.failed", message: `${failed} of ${total} example${plural(total)} fail.` },
    };
  }
  // A declared set with unaccounted outcomes has examples that never ran: the missing outcomes are
  // evidence the page does not have, so it can never be verified on the strength of its examples.
  if (passed + failed < total) {
    return {
      level: "at-risk",
      state: "missing",
      value: "unknown",
      reason: {
        code: "examples.incomplete",
        message: `Only ${passed + failed} of ${total} example${plural(total)} ran, so the page cannot be verified.`,
      },
    };
  }
  if (total > 0) {
    return {
      level: "verified",
      state: "positive",
      value: 0,
      reason: { code: "examples.passed", message: `No example fails; ${passed} of ${total} pass.` },
    };
  }
  return {
    level: "verified",
    state: "neutral",
    value: "unknown",
    reason: { code: "examples.none", message: "The page declares no runnable examples." },
  };
}

/** The drift reason: findings are at-risk, zero is clean, and a count that is absent or malformed is unverified. */
function driftVerdict(drift: number | undefined): SignalVerdict {
  // Only a whole, finite, non-negative safe integer is a measurement. A fractional count is never
  // truncated towards a clean zero or into a finding; it means drift was not checked.
  if (!isWholeCount(drift)) {
    return {
      level: "at-risk",
      state: "missing",
      value: "unknown",
      reason: {
        code: "drift.unknown",
        message: "Drift was not checked, so the page cannot be verified.",
      },
    };
  }
  const findings = drift;
  if (findings > 0) {
    return {
      level: "at-risk",
      state: "negative",
      value: findings,
      reason: {
        code: "drift.findings",
        message: `${findings} drift finding${plural(findings)}: the page no longer matches the code it cites.`,
      },
    };
  }
  return {
    level: "verified",
    state: "positive",
    value: 0,
    reason: { code: "drift.clean", message: "No drift findings." },
  };
}

/** True when the caller supplied an age that can be measured, before truncation. */
function ageKnown(reviewAgeDays: number | "unknown" | undefined): reviewAgeDays is number {
  return reviewAgeDays !== undefined && reviewAgeDays !== "unknown" && Number.isFinite(reviewAgeDays);
}

/**
 * The review reason: a recent review is good, an old or unknown one needs attention, and evidence that
 * contradicts itself is never treated as fresh.
 */
function reviewVerdict(
  reviewAgeDays: number | "unknown" | undefined,
  reviewDueDays: number,
  coverage: ReviewCoverage | undefined,
): SignalVerdict {
  if (!ageKnown(reviewAgeDays)) {
    return {
      level: "review-due",
      state: "missing",
      value: "unknown",
      reason: {
        code: "review.unknown",
        message: "The review age is unknown, so the page cannot be confirmed as reviewed.",
      },
    };
  }
  const age = Math.trunc(reviewAgeDays);

  // A supplied age that git's coverage denies, or a review dated after the measured instant, cannot be confirmed.
  if (coverage === "untracked" || coverage === "unavailable") {
    return {
      level: "review-due",
      state: "conflict",
      value: age,
      reason: {
        code: "review.conflict",
        message: `No review is recorded (${coverage}), so the supplied review age cannot be confirmed.`,
      },
    };
  }
  if (reviewAgeDays < 0) {
    return {
      level: "review-due",
      state: "conflict",
      value: age,
      reason: {
        code: "review.conflict",
        message: "The review date is in the future, so the page cannot be confirmed as reviewed.",
      },
    };
  }
  if (age > reviewDueDays) {
    return {
      level: "review-due",
      state: "negative",
      value: age,
      reason: {
        code: "review.overdue",
        message: `Last reviewed ${age} day${plural(age)} ago, past the ${reviewDueDays}-day limit.`,
      },
    };
  }
  return {
    level: "verified",
    state: "positive",
    value: age,
    reason: {
      code: "review.recent",
      message: `Last reviewed ${age} day${plural(age)} ago, within the ${reviewDueDays}-day limit.`,
    },
  };
}

/**
 * The coverage a page reports: the caller's answer when it gave one, otherwise `recorded` for a known age and
 * `unknown` without one. An unrecognized value at run time is ignored rather than trusted.
 */
function coverageOf(input: TrustScoreInput): ReviewCoverage | "unknown" {
  const given = input.reviewCoverage;
  if (given === "recorded" || given === "untracked" || given === "unavailable") return given;
  return ageKnown(input.reviewAgeDays) ? "recorded" : "unknown";
}

/** The worse of two levels, with `at-risk` worst and `verified` best. */
function worse(a: TrustLevel, b: TrustLevel): TrustLevel {
  const rank: Readonly<Record<TrustLevel, number>> = { verified: 0, "review-due": 1, "at-risk": 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** One factor built from its signal and verdict, so the factor order cannot drift from the reason order. */
function factorOf(signal: TrustSignal, verdict: SignalVerdict): TrustFactor {
  return { signal, code: verdict.reason.code, state: verdict.state, value: verdict.value };
}

/**
 * Combines example results, drift findings, and review age into one trust level plus the reasons and
 * machine-readable factors behind it. The rules and their defaults are in the module comment; the review
 * threshold is overridable with `{ thresholds: { reviewDueDays } }`, and no option can let a failing example, a
 * drift finding, or conflicting evidence pass.
 *
 * The result depends only on the argument: no clock, filesystem, network, or environment is read, and
 * reasons and factors come in the fixed order examples, drift, review. A page with one failing example is
 * `at-risk` in every case.
 */
export function trustScore(input: TrustScoreInput, options: TrustScoreOptions = {}): TrustScore {
  const reviewDueDays = reviewDueDaysOf(options);
  const examples = exampleVerdict(input.examples);
  const drift = driftVerdict(input.drift);
  const review = reviewVerdict(input.reviewAgeDays, reviewDueDays, input.reviewCoverage);

  return {
    level: worse(worse(examples.level, drift.level), review.level),
    reasons: [examples.reason, drift.reason, review.reason],
    factors: [factorOf("examples", examples), factorOf("drift", drift), factorOf("review", review)],
    reviewCoverage: coverageOf(input),
  };
}
