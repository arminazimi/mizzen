/**
 * Issue M3.14 (#142): declared examples whose outcomes do not account for every example are
 * incomplete evidence, never a positive passing signal.
 *
 * A declared set with `passed + failed < total` has examples that never ran, so the page cannot be
 * verified on the strength of its examples, including when both counts are zero. A fully accounted
 * passing set stays positive, a failure keeps its stronger negative reason, and malformed or
 * contradictory counts keep their existing conflict, never clamped into an incomplete or passing set.
 * One test also pins the stable code into the serialized trust schema, so reasons and factors agree
 * in code, state, order, and schema.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { trustScore, type TrustExamples, type TrustScoreInput } from "../src/model/trust-score.ts";

/** A page whose other signals are healthy, so only its examples can decide the level. */
const HEALTHY: Omit<TrustScoreInput, "examples"> = { drift: 0, reviewAgeDays: 1 };

/** Declared example sets that no run accounts for completely. */
const INCOMPLETE: readonly TrustExamples[] = [
  { total: 1, passed: 0, failed: 0 },
  { total: 3, passed: 0, failed: 0 },
  { total: 3, passed: 2, failed: 0 },
  { total: Number.MAX_SAFE_INTEGER, passed: 0, failed: 0 },
];

/** One verified-shaped input whose examples signal is the given counts. */
function withExamples(examples: TrustExamples): TrustScoreInput {
  return { examples, ...HEALTHY };
}

test("an example set with unaccounted outcomes is never verified on its examples", () => {
  const options = [{}, { thresholds: { reviewDueDays: 10_000 } }] as const;
  for (const examples of INCOMPLETE) {
    for (const option of options) {
      const score = trustScore(withExamples(examples), option);
      assert.notEqual(score.level, "verified", JSON.stringify({ examples, option }));
      assert.equal(score.level, "at-risk", JSON.stringify({ examples, option }));
      assert.deepEqual(score.factors[0], {
        signal: "examples",
        code: "examples.incomplete",
        state: "missing",
        value: "unknown",
      });
      assert.deepEqual(
        score.reasons.map((reason) => reason.code),
        ["examples.incomplete", "drift.clean", "review.recent"],
        JSON.stringify(examples),
      );
    }
  }
});

test("the incomplete reason names the examples that never ran", () => {
  const noneRan = trustScore(withExamples({ total: 3, passed: 0, failed: 0 }));
  assert.equal(noneRan.reasons[0]!.message, "Only 0 of 3 examples ran, so the page cannot be verified.");

  const someRan = trustScore(withExamples({ total: 3, passed: 2, failed: 0 }));
  assert.equal(someRan.reasons[0]!.message, "Only 2 of 3 examples ran, so the page cannot be verified.");

  const one = trustScore(withExamples({ total: 1, passed: 0, failed: 0 }));
  assert.equal(one.reasons[0]!.message, "Only 0 of 1 example ran, so the page cannot be verified.");
});

test("a fully accounted passing set stays positive and verified", () => {
  const score = trustScore(withExamples({ total: 3, passed: 3, failed: 0 }));
  assert.equal(score.level, "verified");
  assert.deepEqual(score.factors[0], { signal: "examples", code: "examples.passed", state: "positive", value: 0 });
  assert.equal(score.reasons[0]!.message, "No example fails; 3 of 3 pass.");

  // A whole set at the safe-integer boundary is still accepted evidence, and still complete.
  const boundary = trustScore(withExamples({ total: Number.MAX_SAFE_INTEGER, passed: Number.MAX_SAFE_INTEGER, failed: 0 }));
  assert.equal(boundary.level, "verified");
  assert.equal(boundary.factors[0]!.code, "examples.passed");
});

test("a failure stays the stronger negative reason when the set is also incomplete", () => {
  const score = trustScore(withExamples({ total: 5, passed: 2, failed: 1 }));
  assert.equal(score.level, "at-risk");
  assert.deepEqual(score.factors[0], { signal: "examples", code: "examples.failed", state: "negative", value: 1 });
  assert.equal(score.reasons[0]!.code, "examples.failed");
  assert.equal(score.reasons[0]!.message, "1 of 5 examples fail.");
});

test("malformed and contradictory counts stay conflicts, never incomplete or passing sets", () => {
  const malformed = [4.9, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2] as const;
  for (const bad of malformed) {
    const score = trustScore(withExamples({ total: bad, passed: 0, failed: 0 }));
    assert.equal(score.level, "at-risk", String(bad));
    assert.deepEqual(score.factors[0], {
      signal: "examples",
      code: "examples.conflict",
      state: "conflict",
      value: "unknown",
    });
  }

  const overCounted = trustScore(withExamples({ total: 1, passed: 2, failed: 0 }));
  assert.equal(overCounted.level, "at-risk");
  assert.deepEqual(overCounted.factors[0], {
    signal: "examples",
    code: "examples.conflict",
    state: "conflict",
    value: 0,
  });

  // Claiming no examples at all is still neutral, not incomplete.
  const none = trustScore(withExamples({ total: 0, passed: 0, failed: 0 }));
  assert.equal(none.level, "verified");
  assert.deepEqual(none.factors[0], { signal: "examples", code: "examples.none", state: "neutral", value: "unknown" });
});

test("reasons and factors agree on the incomplete code, state, order, and schema", () => {
  const score = trustScore(withExamples({ total: 2, passed: 1, failed: 0 }));
  assert.deepEqual(
    score.factors.map((factor) => factor.code),
    score.reasons.map((reason) => reason.code),
  );
  assert.deepEqual(
    score.factors.map((factor) => factor.signal),
    ["examples", "drift", "review"],
  );
  assert.equal(score.factors[0]!.state, "missing");

  const schema = JSON.parse(
    readFileSync(new URL("../schema/trust.schema.json", import.meta.url), "utf8"),
  ) as {
    $defs: {
      factor: { properties: { code: { enum: readonly string[] } } };
      reason: { properties: { code: { enum: readonly string[] } } };
    };
  };
  assert.ok(schema.$defs.factor.properties.code.enum.includes("examples.incomplete"));
  assert.ok(schema.$defs.reason.properties.code.enum.includes("examples.incomplete"));
});
