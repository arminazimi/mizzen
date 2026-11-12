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

test("malformed counts are refused, never clamped, while ages are read as whole numbers", () => {
  // Issue M3.10: fractional example and drift counts are malformed evidence, not truncated evidence.
  const score = trustScore({
    examples: { total: 4.9, passed: 4.9, failed: 0.4 },
    drift: 0.9,
    reviewAgeDays: 1.9,
  });
  assert.equal(score.level, "at-risk");
  assert.equal(score.reasons[0]!.code, "examples.conflict");
  assert.equal(score.reasons[1]!.code, "drift.unknown");

  // Ages keep their documented whole-day reading.
  assert.equal(score.reasons[2]!.message, "Last reviewed 1 day ago, within the 180-day limit.");

  // A negative age is a review dated after the measured instant: it cannot be confirmed, so it is a conflict.
  assert.equal(trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: -5 }).level, "review-due");
  assert.equal(codesOf({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: -5 })[2], "review.conflict");
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

test("every reason has a machine-readable factor with the same code, in the same fixed order", () => {
  const score = trustScore(VERIFIED);
  assert.deepEqual(score.factors, [
    { signal: "examples", code: "examples.passed", state: "positive", value: 0 },
    { signal: "drift", code: "drift.clean", state: "positive", value: 0 },
    { signal: "review", code: "review.recent", state: "positive", value: 10 },
  ]);
  assert.equal(score.reviewCoverage, "recorded");
  for (const factor of score.factors) assert.equal("message" in factor, false, "a factor carries no wording");
});

test("missing evidence is a missing factor, never a healthy one", () => {
  const score = trustScore({});
  assert.equal(score.level, "at-risk");
  assert.deepEqual(score.factors, [
    { signal: "examples", code: "examples.none", state: "neutral", value: "unknown" },
    { signal: "drift", code: "drift.unknown", state: "missing", value: "unknown" },
    { signal: "review", code: "review.unknown", state: "missing", value: "unknown" },
  ]);
  assert.equal(score.reviewCoverage, "unknown");

  // Naming a coverage that claims a record exists cannot upgrade an unknown age.
  const recorded = trustScore({ drift: 0, reviewAgeDays: "unknown", reviewCoverage: "recorded" });
  assert.equal(recorded.level, "review-due");
  assert.equal(recorded.factors[2]!.state, "missing");
});

test("example counts that disagree are a conflict, not a pass", () => {
  const conflicting: readonly { total: number; passed: number; failed: number }[] = [
    { total: 1, passed: 2, failed: 0 },
    { total: 2, passed: 1, failed: 2 },
    { total: 0, passed: 0, failed: 1 },
  ];
  for (const examples of conflicting) {
    const score = trustScore({ examples, drift: 0, reviewAgeDays: 1 }, { thresholds: { reviewDueDays: 10_000 } });
    assert.equal(score.level, "at-risk", JSON.stringify(examples));
    assert.deepEqual(score.factors[0], {
      signal: "examples",
      code: "examples.conflict",
      state: "conflict",
      value: examples.failed,
    });
  }
});

test("a review age that its coverage denies is a conflict, never verified", () => {
  for (const reviewCoverage of ["untracked", "unavailable"] as const) {
    const score = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 1, reviewCoverage });
    assert.equal(score.level, "review-due", reviewCoverage);
    assert.deepEqual(score.factors[2], {
      signal: "review",
      code: "review.conflict",
      state: "conflict",
      value: 1,
    });
    assert.equal(score.reviewCoverage, reviewCoverage);
  }
});

test("a review dated after the measured instant is a conflict, not a fresh review", () => {
  const score = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: -1 });
  assert.equal(score.level, "review-due");
  assert.equal(score.factors[2]!.code, "review.conflict");
  assert.equal(score.factors[2]!.value, -1);
});

test("coverage is derived from the age when the caller gives none, and never inflates it", () => {
  assert.equal(trustScore({ reviewAgeDays: 0 }).reviewCoverage, "recorded");
  assert.equal(trustScore({ reviewAgeDays: "unknown" }).reviewCoverage, "unknown");
  assert.equal(trustScore({}).reviewCoverage, "unknown");
  assert.equal(trustScore({ reviewAgeDays: 0, reviewCoverage: "recorded" }).reviewCoverage, "recorded");
  assert.equal(trustScore({ reviewAgeDays: 1, reviewCoverage: "untracked" }).reviewCoverage, "untracked");

  // An unrecognized coverage at run time is ignored instead of trusted.
  const bogus = { reviewAgeDays: 0, reviewCoverage: "bogus" } as unknown as TrustScoreInput;
  assert.equal(trustScore(bogus).reviewCoverage, "recorded");
});

test("the newest allowed review age stays verified, and one more day is due", () => {
  const options = { thresholds: { reviewDueDays: 30 } } as const;
  const atLimit = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 30, reviewCoverage: "recorded" }, options);
  assert.equal(atLimit.level, "verified");
  assert.equal(atLimit.factors[2]!.value, 30);

  const past = trustScore({ examples: CLEAN_EXAMPLES, drift: 0, reviewAgeDays: 31, reviewCoverage: "recorded" }, options);
  assert.equal(past.level, "review-due");
  assert.equal(past.factors[2]!.state, "negative");
});

test("the score serializes deterministically, with a fixed key order", () => {
  const first = trustScore({ examples: CLEAN_EXAMPLES, drift: 2, reviewAgeDays: 10, reviewCoverage: "recorded" });
  const reordered = trustScore({ reviewCoverage: "recorded", reviewAgeDays: 10, drift: 2, examples: CLEAN_EXAMPLES });
  assert.deepEqual(reordered, first);
  assert.deepEqual(Object.keys(first), ["level", "reasons", "factors", "reviewCoverage"]);

  const parsed = JSON.parse(JSON.stringify(first)) as { level: string; reviewCoverage: string; factors: unknown[] };
  assert.equal(parsed.level, "at-risk");
  assert.equal(parsed.reviewCoverage, "recorded");
  assert.equal(parsed.factors.length, 3);
});

