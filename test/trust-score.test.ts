import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REVIEW_DUE_DAYS,
  reviewDueDaysOf,
  trustScore,
  type TrustScoreInput,
} from "../src/model/trust-score.ts";

/** The example counts of a page whose three recorded examples all pass. */
const CLEAN_EXAMPLES = { total: 3, passed: 3, failed: 0 } as const;

/** A page with healthy examples, no drift, and a review ten days old. */
const VERIFIED: TrustScoreInput = { examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 10 };

/** The reason codes of one score, in the order it returns them. */
function codesOf(input: TrustScoreInput, options?: Parameters<typeof trustScore>[1]): readonly string[] {
  return trustScore(input, options).reasons.map((reason) => reason.code);
}

test("a healthy page is verified, with one reason per signal in a fixed order", () => {
  const score = trustScore(VERIFIED);
  assert.equal(score.level, "verified");
  assert.deepEqual(
    score.reasons.map((reason) => reason.code),
    ["examples.passed", "drift.clean", "review.recent"],
  );
  assert.equal(score.reasons[0]!.message, "No example fails; 3 of 3 pass.");
  assert.equal(score.reasons[1]!.message, "No drift findings.");
  assert.equal(score.reasons[2]!.message, "Last reviewed 10 days ago, within the 180-day limit.");
});

test("a page with no examples is not penalised for having none", () => {
  const score = trustScore({ drift: 0, reviewAgeDays: 0 });
  assert.equal(score.level, "verified");
  assert.deepEqual(codesOf({ drift: 0, reviewAgeDays: 0 }), ["examples.none", "drift.clean", "review.recent"]);
  assert.equal(score.reasons[0]!.message, "The page declares no runnable examples.");
});

test("one failing example makes the page at-risk", () => {
  const score = trustScore({ examples: { total: 3, passed: 2, failed: 1 }, drift: 0, reviewAgeDays: 1 });
  assert.equal(score.level, "at-risk");
  assert.deepEqual(
    score.reasons.map((reason) => reason.code),
    ["examples.failed", "drift.clean", "review.recent"],
  );
  assert.equal(score.reasons[0]!.message, "1 of 3 examples fail.");
});

test("a failing example can never be verified, whatever the other signals and thresholds say", () => {
  const failing = { total: 2, passed: 1, failed: 1 } as const;
  const inputs: readonly TrustScoreInput[] = [
    { examples: failing },
    { examples: failing, drift: 0 },
    { examples: failing, drift: 0, reviewAgeDays: 0 },
    { examples: failing, drift: 0, reviewAgeDays: "unknown" },
  ];
  const options = [{}, { thresholds: { reviewDueDays: 10_000 } }] as const;
  for (const input of inputs) {
    for (const option of options) {
      const score = trustScore(input, option);
      assert.equal(score.level, "at-risk", JSON.stringify({ input, option }));
      assert.equal(codesOf(input, option)[0], "examples.failed");
    }
  }
});

test("drift findings make the page at-risk", () => {
  const score = trustScore({ examples: CLEAN_EXAMPLES, drift: 2, reviewAgeDays: 1 });
  assert.equal(score.level, "at-risk");
  assert.deepEqual(
    score.reasons.map((reason) => reason.code),
    ["examples.passed", "drift.findings", "review.recent"],
  );
  assert.equal(score.reasons[1]!.message, "2 drift findings: the page no longer matches the code it cites.");
});

test("drift that was not checked is at-risk, never treated as clean", () => {
  const score = trustScore({ examples: CLEAN_EXAMPLES, reviewAgeDays: 1 });
  assert.equal(score.level, "at-risk");
  assert.equal(score.reasons[1]!.code, "drift.unknown");
  assert.equal(score.reasons[1]!.message, "Drift was not checked, so the page cannot be verified.");
});

test("a review older than the default 180 days is review-due", () => {
  assert.equal(DEFAULT_REVIEW_DUE_DAYS, 180);
  const score = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 181 });
  assert.equal(score.level, "review-due");
  assert.deepEqual(
    score.reasons.map((reason) => reason.code),
    ["examples.passed", "drift.clean", "review.overdue"],
  );
  assert.equal(score.reasons[2]!.message, "Last reviewed 181 days ago, past the 180-day limit.");
});

test("exactly 180 days is still within the default limit", () => {
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 180 }).level, "verified");
});

test("an unknown review age is review-due, and so is an omitted age", () => {
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: "unknown" }).level, "review-due");
  assert.deepEqual(codesOf({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: "unknown" }), [
    "examples.passed",
    "drift.clean",
    "review.unknown",
  ]);
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 0 }).level, "review-due");
  assert.equal(codesOf({ examples: CLEAN_EXAMPLES, drift: 0 })[2], "review.unknown");
});

test("the review threshold is overridable and defaults when the option is invalid", () => {
  const input: TrustScoreInput = { examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 90 };
  assert.equal(trustScore(input).level, "verified");
  assert.equal(trustScore(input, { thresholds: { reviewDueDays: 30 } }).level, "review-due");
  assert.equal(trustScore(input, { thresholds: { reviewDueDays: 90 } }).level, "verified");
  assert.equal(trustScore(input, { thresholds: { reviewDueDays: 91 } }).level, "verified");

  // An invalid threshold falls back to the documented default of 180.
  assert.equal(reviewDueDaysOf({ thresholds: { reviewDueDays: -1 } }), 180);
  assert.equal(reviewDueDaysOf({ thresholds: { reviewDueDays: Number.NaN } }), 180);
  assert.equal(reviewDueDaysOf({ thresholds: { reviewDueDays: Number.POSITIVE_INFINITY } }), 180);
  assert.equal(reviewDueDaysOf(), 180);
  assert.equal(reviewDueDaysOf({ thresholds: { reviewDueDays: 0 } }), 0);
  assert.equal(reviewDueDaysOf({ thresholds: { reviewDueDays: 12.9 } }), 12);
  assert.equal(
    trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 1 }, { thresholds: { reviewDueDays: 0 } }).level,
    "review-due",
  );
});

test("counts and ages are read as whole, non-negative numbers", () => {
  const score = trustScore({
    examples: { total: 4.9, passed: 4.9, failed: 0.4 },
    drift: 0.9,
    reviewAgeDays: 1.9,
  });
  assert.equal(score.level, "verified");
  assert.equal(score.reasons[0]!.message, "No example fails; 4 of 4 pass.");
  assert.equal(score.reasons[1]!.message, "No drift findings.");
  assert.equal(score.reasons[2]!.message, "Last reviewed 1 day ago, within the 180-day limit.");

  // A negative age counts as zero, so it is fresh rather than unknown.
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: -5 }).level, "verified");
  assert.equal(codesOf({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: -5 })[2], "review.recent");
});

test("the result is deterministic, and the reason order never depends on the input shape", () => {
  const first = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 10 });
  const second = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 10 });
  assert.deepEqual(second, first);

  // Signals the same, fields written in another order: the output is the same.
  const reordered = trustScore({ reviewAgeDays: 10, drift: 0, examples: CLEAN_EXAMPLES });
  assert.deepEqual(reordered, first);

  // The worst signal sets the level, and every signal still explains itself in the fixed order.
  const mixed = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: "unknown" });
  assert.equal(mixed.level, "review-due");
  assert.deepEqual(
    mixed.reasons.map((reason) => reason.code),
    ["examples.passed", "drift.clean", "review.unknown"],
  );
  assert.deepEqual(codesOf({ examples: CLEAN_EXAMPLES, drift: 1, reviewAgeDays: 400 }), [
    "examples.passed",
    "drift.findings",
    "review.overdue",
  ]);
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 1, reviewAgeDays: 400 }).level, "at-risk");
});

