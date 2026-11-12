/**
 * Issue M3.10 (#102): malformed trust counts are rejected, never clamped.
 *
 * A supplied example count or drift count must be a whole, finite, non-negative safe integer to be
 * evidence at all. Fractional, negative, NaN, infinite, and unsafe values become explicit conflict
 * (examples) or missing (drift) reasons and factors, so malformed data can never yield a positive
 * example or drift factor. Genuinely absent examples stay neutral, a measured zero drift stays
 * clean, contradictory whole counts keep their existing conservative conflict, and valid counts,
 * absent signals, unknown review ages, and threshold boundaries keep their current results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { trustScore, type TrustExamples, type TrustScoreInput } from "../src/model/trust-score.ts";

/** Supplied counts that cannot be evidence: fractional, negative, non-finite, or beyond safe integers. */
const MALFORMED: readonly number[] = [
  0.5,
  -1,
  -0.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  -(Number.MAX_SAFE_INTEGER + 2),
];

/** Healthy counts with the given value standing in for each field in turn. */
function examplesWithBadCount(bad: number): readonly TrustExamples[] {
  return [
    { total: bad, passed: 2, failed: 0 },
    { total: 3, passed: bad, failed: 0 },
    { total: 3, passed: 2, failed: bad },
  ];
}

/** One verified-shaped input whose examples signal is the given counts. */
function withExamples(examples: TrustExamples): TrustScoreInput {
  return { examples, drift: 0, reviewAgeDays: 1 };
}

test("a malformed example count is an explicit conflict, never a positive factor", () => {
  for (const bad of MALFORMED) {
    for (const examples of examplesWithBadCount(bad)) {
      const score = trustScore(withExamples(examples));
      assert.equal(score.level, "at-risk", JSON.stringify({ bad, examples }));
      assert.deepEqual(score.factors[0], {
        signal: "examples",
        code: "examples.conflict",
        state: "conflict",
        value: "unknown",
      });
      assert.equal(score.factors[0]!.state !== "positive", true);
      assert.equal(score.reasons[0]!.code, "examples.conflict");
      assert.match(score.reasons[0]!.message, /cannot be verified/);
    }
  }
});

test("a fractional example total cannot be truncated or reconstructed into a pass", () => {
  // The old behaviour truncated 4.9 to 4 and reported "4 of 4 pass" as a positive factor.
  const inflated = trustScore(withExamples({ total: 4.9, passed: 4.9, failed: 0 }));
  assert.equal(inflated.level, "at-risk");
  assert.equal(inflated.factors[0]!.code, "examples.conflict");
  assert.equal(inflated.factors[0]!.state, "conflict");
  assert.equal(inflated.factors[0]!.value, "unknown");
  assert.match(inflated.reasons[0]!.message, /4\.9/);

  // A malformed total cannot hide a real pass either: the whole set is refused, not repaired.
  const halfTotal = trustScore(withExamples({ total: 3.5, passed: 3, failed: 0 }));
  assert.equal(halfTotal.level, "at-risk");
  assert.equal(halfTotal.factors[0]!.state, "conflict");

  // A NaN total cannot be rebuilt from the pass and fail counts to make them look complete.
  const nanTotal = trustScore(withExamples({ total: Number.NaN, passed: 100, failed: 0 }));
  assert.equal(nanTotal.level, "at-risk");
  assert.deepEqual(nanTotal.factors[0], {
    signal: "examples",
    code: "examples.conflict",
    state: "conflict",
    value: "unknown",
  });
});

test("a malformed drift count is a missing signal, never clean and never a finding count", () => {
  for (const bad of MALFORMED) {
    const score = trustScore({ examples: { total: 3, passed: 3, failed: 0 }, drift: bad, reviewAgeDays: 1 });
    assert.equal(score.level, "at-risk", String(bad));
    assert.deepEqual(score.factors[1], {
      signal: "drift",
      code: "drift.unknown",
      state: "missing",
      value: "unknown",
    });
    assert.equal(
      score.reasons[1]!.message,
      "Drift was not checked, so the page cannot be verified.",
      `malformed drift ${bad} is not silently repaired to a count`,
    );
  }

  // A fractional finding count used to truncate to either a positive clean or a negative count.
  assert.equal(trustScore({ drift: 0.9, reviewAgeDays: 1, examples: { total: 1, passed: 1, failed: 0 } }).factors[1]!.code, "drift.unknown");
  assert.equal(trustScore({ drift: 2.5, reviewAgeDays: 1, examples: { total: 1, passed: 1, failed: 0 } }).factors[1]!.code, "drift.unknown");
});

test("absent examples stay neutral and a measured zero drift stays clean", () => {
  // No examples object at all is genuinely absent evidence, not malformed evidence.
  const absent = trustScore({ drift: 0, reviewAgeDays: 1 });
  assert.equal(absent.level, "verified");
  assert.deepEqual(absent.factors[0], { signal: "examples", code: "examples.none", state: "neutral", value: "unknown" });

  // Whole zero counts declare no runnable example: still the neutral examples.none, unchanged.
  const zeros = trustScore({ examples: { total: 0, passed: 0, failed: 0 }, drift: 0, reviewAgeDays: 1 });
  assert.equal(zeros.level, "verified");
  assert.equal(zeros.factors[0]!.code, "examples.none");
  assert.equal(zeros.factors[0]!.state, "neutral");

  // A measured drift of exactly zero is clean, positive evidence.
  assert.deepEqual(trustScore({ drift: 0, reviewAgeDays: 1 }).factors[1], {
    signal: "drift",
    code: "drift.clean",
    state: "positive",
    value: 0,
  });

  // Omitted drift remains the same missing signal it always was.
  assert.equal(trustScore({ examples: { total: 1, passed: 1, failed: 0 }, reviewAgeDays: 1 }).factors[1]!.code, "drift.unknown");
  assert.equal(trustScore({ examples: { total: 1, passed: 1, failed: 0 }, reviewAgeDays: 1 }).factors[1]!.state, "missing");
});

test("contradictory whole counts keep their existing conservative conflict", () => {
  const conflicting: readonly TrustExamples[] = [
    { total: 1, passed: 2, failed: 0 },
    { total: 2, passed: 1, failed: 2 },
    { total: 0, passed: 0, failed: 1 },
  ];
  for (const examples of conflicting) {
    const score = trustScore({ examples, drift: 0, reviewAgeDays: 1 });
    assert.equal(score.level, "at-risk", JSON.stringify(examples));
    assert.deepEqual(score.factors[0], {
      signal: "examples",
      code: "examples.conflict",
      state: "conflict",
      value: examples.failed,
    });
    assert.equal(
      score.reasons[0]!.message,
      `The example counts disagree: ${examples.passed} pass and ${examples.failed} fail of ${examples.total}, so the page cannot be verified.`,
    );
  }
});

test("valid counts, threshold boundaries, and unknown ages keep their current results", () => {
  const healthy: TrustExamples = { total: 3, passed: 3, failed: 0 };

  // A whole valid count at the safe-integer boundary is still accepted evidence.
  const huge = trustScore(withExamples({ total: Number.MAX_SAFE_INTEGER, passed: Number.MAX_SAFE_INTEGER, failed: 0 }));
  assert.equal(huge.factors[0]!.state, "positive");
  assert.equal(huge.factors[0]!.code, "examples.passed");

  // Failing evidence is still reported as a failure, not as malformed.
  const failing = trustScore(withExamples({ total: 3, passed: 2, failed: 1 }));
  assert.deepEqual(failing.factors[0], { signal: "examples", code: "examples.failed", state: "negative", value: 1 });

  // Drift findings above zero stay negative findings; zero is clean.
  assert.deepEqual(trustScore({ drift: 2, reviewAgeDays: 1 }).factors[1], {
    signal: "drift",
    code: "drift.findings",
    state: "negative",
    value: 2,
  });

  // Review-age behaviour is untouched by the count rules: the boundary days and the unknown age.
  assert.equal(trustScore({ examples: healthy, drift: 0, reviewAgeDays: 180 }).level, "verified");
  assert.equal(trustScore({ examples: healthy, drift: 0, reviewAgeDays: 181 }).level, "review-due");
  assert.equal(trustScore({ examples: healthy, drift: 0, reviewAgeDays: "unknown" }).factors[2]!.code, "review.unknown");
  assert.equal(trustScore({ examples: healthy, drift: 0 }).factors[2]!.code, "review.unknown");
  assert.equal(trustScore({ examples: healthy, drift: 0, reviewAgeDays: -5 }).factors[2]!.code, "review.conflict");

  // A fractional review age is still read as whole days, as documented for the age signal.
  const fractionalAge = trustScore({ examples: healthy, drift: 0, reviewAgeDays: 1.9 });
  assert.equal(fractionalAge.factors[2]!.code, "review.recent");
  assert.equal(fractionalAge.factors[2]!.value, 1);

  // A fully healthy page is still verified.
  assert.equal(trustScore({ examples: healthy, drift: 0, reviewAgeDays: 10 }).level, "verified");
});

test("the reason and factor order and count never change for malformed evidence", () => {
  for (const bad of MALFORMED) {
    const score = trustScore({ examples: { total: bad, passed: 2, failed: 0 }, drift: bad, reviewAgeDays: "unknown" });
    assert.equal(score.reasons.length, 3);
    assert.equal(score.factors.length, 3);
    assert.deepEqual(
      score.reasons.map((reason) => reason.code),
      ["examples.conflict", "drift.unknown", "review.unknown"],
      String(bad),
    );
    assert.deepEqual(
      score.factors.map((factor) => factor.signal),
      ["examples", "drift", "review"],
    );
    assert.equal(score.level, "at-risk");

    // Deterministic: the same malformed input always gives the same output.
    assert.deepEqual(trustScore({ examples: { total: bad, passed: 2, failed: 0 }, drift: bad, reviewAgeDays: "unknown" }), score);
  }
});
