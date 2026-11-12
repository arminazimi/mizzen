/**
 * M5.10: `compilePack` ranks with the trust evidence it publishes, measured in one build.
 *
 * Every case drives the compiler with an in-memory site, so no clock, git, or network reaches it, and
 * with a caller-supplied trust map, so the measured evidence is exactly what the case names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextRequest } from "../src/contracts/context-request.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import type { PackItem } from "../src/outputs/context-pack.ts";
import type { TrustEntry } from "../src/outputs/trust.ts";
import { compilePack } from "../src/packs/compile.ts";
import { rankPages, type RankReason } from "../src/packs/rank.ts";

const MEASURED = ["examples", "drift", "review"] as const;

/** A source span inside one file. */
function pos(file: string): { file: string; line: number; column: number; endLine: number; endColumn: number } {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/** A doc page whose whole text is `text`, from `source`. */
function page(url: string, source: string, text: string): Page {
  return {
    url,
    source: pos(source),
    frontMatter: {},
    title: "Deploy the site",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: text,
    kind: "doc",
  };
}

/** A site holding pages at `/guide/alpha/` and `/guide/beta/` with identical text, so they are comparable. */
function site(): Site {
  const config: SiteConfig = {
    title: "Mizzen",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  };
  const text = "# Deploy the site\n\nDeploy the built site. Deploy once per release.\n";
  return {
    config,
    pages: [page("/guide/alpha/", "guide/alpha.md", text), page("/guide/beta/", "guide/beta.md", text)],
    nav: {},
    data: {},
  };
}

/** A request for the one term both pages carry. */
function request(extra: Partial<ContextRequest> = {}): ContextRequest {
  return {
    version: 1,
    task: { goal: "deploy" },
    include: [],
    exclude: [],
    constraints: {},
    budget: { maxTokens: 6000 },
    requiredEvidence: { refs: [], source: false, versions: false, warnings: false, dependencies: false },
    ...extra,
  };
}

/** An output context that reports nothing and renders nothing. */
function context(): OutputContext {
  return {
    renderPage: () => Promise.resolve(""),
    report: () => {},
  };
}

/** The measured evidence of a page that passes every signal, reviewed ten days ago and recorded in git. */
function healthy(lastReviewer = "Armin"): TrustEntry {
  return {
    evidence: { examples: "measured", drift: "measured", review: "measured" },
    level: "verified",
    factors: [
      { signal: "examples", code: "examples.passed", state: "positive", value: 0 },
      { signal: "drift", code: "drift.clean", state: "positive", value: 0 },
      { signal: "review", code: "review.recent", state: "positive", value: 10 },
    ],
    reviewCoverage: "recorded",
    reasons: [
      { code: "examples.passed", message: "No example fails; 2 of 2 pass." },
      { code: "drift.clean", message: "No drift finding." },
      { code: "review.recent", message: "Reviewed 10 days ago." },
    ],
    ...(lastReviewer === "" ? {} : { lastReviewer }),
  };
}

/** The measured evidence of a page that fails every signal. */
function failing(): TrustEntry {
  return {
    evidence: { examples: "measured", drift: "measured", review: "measured" },
    level: "at-risk",
    factors: [
      { signal: "examples", code: "examples.failed", state: "negative", value: 2 },
      { signal: "drift", code: "drift.findings", state: "negative", value: 3 },
      { signal: "review", code: "review.overdue", state: "negative", value: 400 },
    ],
    reviewCoverage: "recorded",
    reasons: [
      { code: "examples.failed", message: "2 of 2 examples fail." },
      { code: "drift.findings", message: "3 drift findings." },
      { code: "review.overdue", message: "Reviewed 400 days ago." },
    ],
  };
}

/** Evidence a page declares no examples for, with clean drift and no review source. */
function neutral(): TrustEntry {
  return {
    evidence: { examples: "none", drift: "measured", review: "missing" },
    level: "review-due",
    factors: [
      { signal: "examples", code: "examples.none", state: "neutral", value: "unknown" },
      { signal: "drift", code: "drift.clean", state: "positive", value: 0 },
      { signal: "review", code: "review.unknown", state: "missing", value: "unknown" },
    ],
    reviewCoverage: "unknown",
    reasons: [
      { code: "examples.none", message: "The page declares no runnable examples." },
      { code: "drift.clean", message: "No drift finding." },
      { code: "review.unknown", message: "No review date is readable." },
    ],
  };
}

/** Evidence whose counts cannot be read: a fractional failure count, a negative drift count, an age of `unknown`. */
function malformed(): TrustEntry {
  return {
    evidence: { examples: "measured", drift: "measured", review: "measured" },
    level: "at-risk",
    factors: [
      { signal: "examples", code: "examples.failed", state: "conflict", value: 1.5 },
      { signal: "drift", code: "drift.findings", state: "conflict", value: -3 },
      { signal: "review", code: "review.conflict", state: "conflict", value: -1 },
    ],
    reasons: [
      { code: "examples.conflict", message: "The example counts disagree." },
      { code: "drift.findings", message: "The drift count is not readable." },
      { code: "review.conflict", message: "The review date is in the future." },
    ],
  };
}

/** A trust map from the site's page URLs. */
function trustOf(entries: Readonly<Record<string, TrustEntry>>): ReadonlyMap<string, TrustEntry> {
  return new Map(Object.entries(entries));
}

/** The reasons of one rank factor, in the order the ranker wrote them. */
function reasonsFor(item: PackItem, factor: string): readonly RankReason[] {
  return item.rank.reasons.filter((reason) => reason.factor === factor);
}

/** The ids of the pack's items, in order. */
function idsOf(items: readonly PackItem[]): readonly string[] {
  return items.map((item) => item.id);
}

test("measured evidence reorders comparable pages and names itself in their rank reasons", async () => {
  const compiled = await compilePack(
    site(),
    request(),
    context(),
    { trust: trustOf({ "/guide/alpha/": failing(), "/guide/beta/": healthy() }) },
  );
  assert.ok(compiled, "the request selects pages");
  const [first, second] = [compiled.evidence.items[0]!, compiled.evidence.items[1]!];

  assert.deepEqual(idsOf(compiled.evidence.items), ["/guide/beta/", "/guide/alpha/"]);
  assert.equal(first.trust?.level, "verified", "the clean page now leads");
  assert.equal(second.trust?.level, "at-risk", "the failing page now follows");
  assert.ok(first.rank.score > second.rank.score, "the measured evidence moves the score");

  const clean = reasonsFor(first, "examples").concat(reasonsFor(first, "drift"), reasonsFor(first, "review"));
  assert.deepEqual(
    clean.map((reason) => reason.factor),
    MEASURED,
    "each measured signal is one reason",
  );
  assert.ok(clean.every((reason) => reason.contribution > 0), "healthy evidence only raises");
  assert.match(clean[0]!.code, /^examples:passed:/);
  assert.equal(clean[1]!.code, "drift:clean");
  assert.equal(clean[2]!.code, "review:recent:10");

  const atRisk = reasonsFor(second, "examples").concat(reasonsFor(second, "drift"), reasonsFor(second, "review"));
  assert.ok(atRisk.every((reason) => reason.contribution < 0), "failing evidence only lowers");
  assert.match(atRisk[0]!.code, /^examples:failed:2\//);
  assert.equal(atRisk[1]!.code, "drift:3");
  assert.equal(atRisk[2]!.code, "review:overdue:400");

  // The reasons must add up to the score the pack publishes, and to the score that ordered the pages.
  for (const item of compiled.evidence.items) {
    const sum = item.rank.reasons.reduce((total, reason) => total + reason.contribution, 0);
    assert.ok(Math.abs(sum - item.rank.score) < 1e-9, `${item.id}'s reasons add up to its score`);
  }
});

test("a task profile decides how far measured evidence moves a page", async () => {
  const trust = trustOf({ "/guide/alpha/": failing(), "/guide/beta/": healthy() });
  const gap = async (kind: "debug" | "explain") => {
    const compiled = await compilePack(site(), request({ task: { goal: "deploy", kind } }), context(), { trust });
    assert.ok(compiled, `${kind} selects pages`);
    const score = (url: string) => compiled.evidence.items.find((item) => item.id === url)!.rank.score;
    assert.ok(score("/guide/beta/") > score("/guide/alpha/"), `${kind}: the clean page leads`);
    return score("/guide/beta/") - score("/guide/alpha/");
  };
  const [debug, explain] = [await gap("debug"), await gap("explain")];
  assert.ok(debug > explain, `the debug profile weights drift most, so its gap (${debug}) beats explain's (${explain})`);
});

test("missing and malformed evidence stays non-positive and cannot pass a measured page", async () => {
  const compiled = await compilePack(
    site(),
    request(),
    context(),
    { trust: trustOf({ "/guide/alpha/": malformed(), "/guide/beta/": healthy() }) },
  );
  assert.ok(compiled);
  const beta = compiled.evidence.items.find((item) => item.id === "/guide/beta/")!;
  const alpha = compiled.evidence.items.find((item) => item.id === "/guide/alpha/")!;

  for (const reason of reasonsFor(alpha, "examples").concat(reasonsFor(alpha, "drift"), reasonsFor(alpha, "review"))) {
    assert.ok(reason.contribution <= 0, `${reason.code} is not read as clean evidence`);
    assert.match(reason.code, /:(unknown|missing|invalid)$/);
  }
  assert.ok(beta.rank.score > alpha.rank.score, "an unreadable page never outranks a measured clean one");

  // A page with no entry at all loses exactly as much as a page whose evidence cannot be read.
  const unmeasured = await compilePack(site(), request(), context(), {
    trust: trustOf({ "/guide/beta/": healthy() }),
  });
  assert.ok(unmeasured);
  const lone = unmeasured.evidence.items.find((item) => item.id === "/guide/alpha/")!;
  assert.equal(lone.rank.score, alpha.rank.score, "malformed evidence is exactly as weak as none");
  assert.equal(lone.trust, undefined, "a page without an entry publishes no trust");

  // Declared-no-examples is neutral, so it neither raises a page nor holds it against the measured ones.
  const declared = await compilePack(site(), request(), context(), {
    trust: trustOf({ "/guide/alpha/": neutral(), "/guide/beta/": neutral() }),
  });
  assert.ok(declared);
  const neutralReasons = reasonsFor(declared.evidence.items[0]!, "examples");
  assert.deepEqual(neutralReasons, [{ factor: "examples", code: "examples:none", contribution: 0 }]);
  assert.equal(declared.evidence.items[0]!.rank.reasons.find((r) => r.factor === "drift")?.code, "drift:clean");
  assert.equal(declared.evidence.items[0]!.rank.reasons.find((r) => r.factor === "review")?.code, "review:missing");
});

test("an entry measured in another build raises no page and publishes no trust", async () => {
  const trust = trustOf({ "/guide/alpha/": failing(), "/guide/beta/": healthy() });
  const plain = await compilePack(site(), request(), context());
  assert.ok(plain);
  assert.deepEqual(idsOf(plain.evidence.items), ["/guide/alpha/", "/guide/beta/"], "without evidence, URL breaks the tie");

  // The same candidates ranked with no measured evidence at all: what a cross-build snapshot must equal.
  const baseline = rankPages(site().pages, "deploy", { base: "" });

  const foreign = await compilePack(site(), request(), context(), {
    trust,
    trustBuild: "0".repeat(64),
  });
  assert.ok(foreign);
  assert.deepEqual(
    foreign.evidence.items.map((item) => [item.id, item.rank.score]),
    baseline.map((entry) => [entry.page.url, entry.score]),
    "another build's evidence is ignored entirely",
  );
  for (const item of foreign.evidence.items) {
    assert.equal(item.trust, undefined, "cross-build evidence is not this build's evidence");
    for (const factor of MEASURED) {
      assert.deepEqual(reasonsFor(item, factor), [], `${factor} is not read from another build`);
    }
  }

  // The very same entries, measured in the build the pack names, do move the pages.
  const same = await compilePack(site(), request(), context(), { trust, trustBuild: plain.evidence.build.id });
  assert.ok(same);
  assert.deepEqual(idsOf(same.evidence.items), ["/guide/beta/", "/guide/alpha/"]);

  const applied = await compilePack(site(), request(), context(), { trust });
  assert.ok(applied);
  assert.deepEqual(idsOf(applied.evidence.items), ["/guide/beta/", "/guide/alpha/"], "no stamp means this build");
});

test("the item's trust, score, reasons, Markdown, and JSON come from one snapshot", async () => {
  const entries = { "/guide/alpha/": failing(), "/guide/beta/": healthy() };
  const compiled = await compilePack(site(), request(), context(), { trust: trustOf(entries) });
  assert.ok(compiled);
  const { evidence, markdown } = compiled;

  for (const item of evidence.items) {
    assert.equal(item.build, evidence.build.id, "the item names the pack's own build");
    assert.deepEqual(item.trust, entries[item.id as keyof typeof entries], "the published entry is the snapshot's");

    // Every measured signal the entry reports appears once in the reasons, with a matching sign.
    const factors = item.trust?.factors ?? [];
    assert.equal(factors.length, 3, "the snapshot carries all three signals");
    for (const factor of factors) {
      const reason = reasonsFor(item, factor.signal)[0];
      assert.ok(reason, `${factor.signal} is ranked from the snapshot`);
      if (factor.state === "positive") assert.ok(reason.contribution > 0, `${reason.code} raises a verified signal`);
      if (factor.state === "negative") assert.ok(reason.contribution < 0, `${reason.code} lowers a failed signal`);
      if (factor.state === "neutral") assert.equal(reason.contribution, 0, `${reason.code} is neutral`);
    }
    assert.equal(
      reasonsFor(item, "examples").length + reasonsFor(item, "drift").length + reasonsFor(item, "review").length,
      3,
      "one reason per measured signal, no more",
    );
  }

  // The Markdown and the JSON are two renderings of the same item list, in the same order.
  assert.equal(markdown.startsWith("# Context pack: deploy\n"), true);
  const sections = evidence.items.map((item) => markdown.indexOf(item.content.trim()));
  assert.deepEqual(
    sections,
    [...sections].sort((a, b) => a - b),
    "the Markdown shows the items in the JSON's order",
  );
  for (const item of evidence.items) {
    assert.ok(markdown.includes(`## ${item.title}`), `Markdown names ${item.id}`);
    assert.ok(markdown.includes(item.content.trim()), `Markdown shows ${item.id}'s content`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence, "the JSON twin survives serialization");

  // The same inputs give the same pack, so the snapshot is deterministic, not order- or clock-driven.
  const again = await compilePack(
    site(),
    request(),
    context(),
    { trust: trustOf({ "/guide/beta/": healthy(), "/guide/alpha/": failing() }) },
  );
  assert.ok(again);
  assert.deepEqual(again.markdown, markdown, "entry order never reaches the pack");
  assert.deepEqual(again.evidence, evidence);
});
