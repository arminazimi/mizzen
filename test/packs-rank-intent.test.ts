import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, PageStatus, SourcePos } from "../src/contracts/index.ts";
import {
  defaultRankWeights,
  rankPages,
  taskRankProfiles,
  type RankTrustEvidence,
  type RankTrustPage,
} from "../src/packs/rank.ts";

function pos(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

interface PageOptions {
  readonly title?: string;
  readonly html?: string;
  readonly markdown?: string;
  readonly source?: string;
  readonly lang?: string;
  readonly status?: PageStatus;
}

function page(url: string, options: PageOptions = {}): Page {
  const source = options.source ?? "guide/page.md";
  const headings: Heading[] = [];
  return {
    url,
    source: pos(source),
    frontMatter: options.status === undefined ? {} : { status: options.status },
    title: options.title ?? "Page",
    lang: options.lang ?? "en",
    dir: "ltr",
    headings,
    html: options.html ?? "",
    markdown: options.markdown ?? "",
    kind: "doc",
  };
}

/** The build identity the fixtures below measure their evidence in. */
const BUILD = "fixture-build";

/** Full healthy measured evidence: examples pass, drift is clean, and the review is recent and recorded. */
function healthy(overrides: Partial<RankTrustPage> = {}): RankTrustPage {
  return {
    examples: { total: 2, passed: 2, failed: 0 },
    drift: 0,
    reviewAgeDays: 10,
    reviewCoverage: "recorded",
    ...overrides,
  };
}

function evidence(pages: Readonly<Record<string, RankTrustPage>>): RankTrustEvidence {
  return { build: BUILD, pages };
}

const KINDS = ["explain", "implement", "review", "debug", "migrate", "other"] as const;

/** The score a page with lexical relevance 8 gets from healthy, failing, drifting, and missing evidence. */
function evidenceScore(kind: (typeof KINDS)[number]): number {
  const weights = { ...defaultRankWeights, ...taskRankProfiles[kind] };
  return 8 + 8 * (weights.examples + weights.drift + weights.review);
}

test("every task kind has a documented profile whose reasons sum exactly to the score", () => {
  const pages = [page("/healthy/", { title: "Install" })];
  const scores = new Set<number>();

  for (const kind of KINDS) {
    const [entry] = rankPages(pages, "install", {
      build: BUILD,
      task: kind,
      trust: evidence({ "/healthy/": healthy() }),
    });
    assert.ok(entry !== undefined, kind);
    assert.deepEqual(
      entry.reasons.map((reason) => reason.factor),
      ["lexical", "examples", "drift", "review"],
      kind,
    );
    assert.deepEqual(
      entry.reasons.map((reason) => reason.code),
      ["title:install", "examples:passed:2/2", "drift:clean", "review:recent:10"],
      kind,
    );
    assert.equal(entry.score, entry.reasons.reduce((sum, reason) => sum + reason.contribution, 0), kind);
    assert.ok(Math.abs(entry.score - evidenceScore(kind)) < 1e-9, kind);
    scores.add(entry.score);
  }

  assert.equal(scores.size, KINDS.length, "each task kind weights the evidence differently");

  const [untasked] = rankPages(pages, "install", { build: BUILD, trust: evidence({ "/healthy/": healthy() }) });
  assert.ok(Math.abs((untasked?.score ?? 0) - evidenceScore("other")) < 1e-9, "the other profile is the untasked default");
});

test("for every task kind, failing, drifting, and missing evidence stays behind equivalent healthy evidence", () => {
  const pages = [
    page("/healthy/", { title: "Install" }),
    page("/failed/", { title: "Install" }),
    page("/drifted/", { title: "Install" }),
    page("/missing/", { title: "Install" }),
  ];
  const trust = evidence({
    "/healthy/": healthy(),
    "/failed/": healthy({ examples: { total: 2, passed: 1, failed: 1 } }),
    "/drifted/": healthy({ drift: 3 }),
  });

  for (const kind of KINDS) {
    const ranked = rankPages(pages, "install", { build: BUILD, task: kind, trust });
    assert.equal(ranked[0]?.page.url, "/healthy/", kind);

    const healthyEntry = ranked.find((entry) => entry.page.url === "/healthy/")!;
    const failed = ranked.find((entry) => entry.page.url === "/failed/")!;
    const drifted = ranked.find((entry) => entry.page.url === "/drifted/")!;
    const missing = ranked.find((entry) => entry.page.url === "/missing/")!;

    assert.ok(healthyEntry.score > failed.score, kind);
    assert.ok(healthyEntry.score > drifted.score, kind);
    assert.ok(healthyEntry.score > missing.score, "missing evidence is not treated as clean");
    assert.ok(
      failed.reasons.some((reason) => reason.factor === "examples" && reason.contribution < 0),
      kind,
    );
    assert.ok(
      drifted.reasons.some((reason) => reason.factor === "drift" && reason.contribution < 0),
      kind,
    );
    assert.ok(
      missing.reasons
        .filter((reason) => ["examples", "drift", "review"].includes(reason.factor))
        .every((reason) => reason.contribution < 0),
      "an unmeasured page never gets a positive evidence reason",
    );
  }
});

test("implement weights runnable examples and debug weights drift findings", () => {
  const pages = [
    page("/healthy/", { title: "Install" }),
    page("/failed/", { title: "Install" }),
    page("/drifted/", { title: "Install" }),
  ];
  const trust = evidence({
    "/healthy/": healthy(),
    "/failed/": healthy({ examples: { total: 2, passed: 1, failed: 1 } }),
    "/drifted/": healthy({ drift: 2 }),
  });

  const implement = rankPages(pages, "install", { build: BUILD, task: "implement", trust });
  assert.equal(
    implement.find((entry) => entry.page.url === "/failed/")?.reasons.find((reason) => reason.factor === "examples")
      ?.contribution,
    -4,
  );
  assert.equal(
    implement.find((entry) => entry.page.url === "/drifted/")?.reasons.find((reason) => reason.factor === "drift")
      ?.contribution,
    -1.2,
  );

  const debug = rankPages(pages, "install", { build: BUILD, task: "debug", trust });
  assert.equal(
    debug.find((entry) => entry.page.url === "/failed/")?.reasons.find((reason) => reason.factor === "examples")
      ?.contribution,
    -2,
  );
  assert.equal(
    debug.find((entry) => entry.page.url === "/drifted/")?.reasons.find((reason) => reason.factor === "drift")
      ?.contribution,
    -4,
  );
});

test("review weights freshness and coverage, and migrate weights version and status", () => {
  const reviewed = [
    page("/fresh/", { title: "Install", source: "fresh.md" }),
    page("/stale/", { title: "Install", source: "stale.md" }),
    page("/untracked/", { title: "Install", source: "untracked.md" }),
  ];
  const trust = evidence({
    "/fresh/": healthy(),
    "/stale/": healthy({ reviewAgeDays: 400 }),
    "/untracked/": healthy({ reviewCoverage: "untracked" }),
  });

  const review = rankPages(reviewed, "install", { build: BUILD, task: "review", trust });
  const reviewReason = (url: string) =>
    review.find((entry) => entry.page.url === url)?.reasons.find((reason) => reason.factor === "review");
  assert.deepEqual(reviewReason("/fresh/"), { factor: "review", code: "review:recent:10", contribution: 4 });
  assert.deepEqual(reviewReason("/stale/"), { factor: "review", code: "review:overdue:400", contribution: -4 });
  assert.deepEqual(reviewReason("/untracked/"), {
    factor: "review",
    code: "review:coverage:untracked",
    contribution: -4,
  });

  const explain = rankPages(reviewed, "install", { build: BUILD, task: "explain", trust });
  assert.equal(
    explain.find((entry) => entry.page.url === "/fresh/")?.reasons.find((reason) => reason.factor === "review")
      ?.contribution,
    2,
  );
  assert.equal(
    explain.find((entry) => entry.page.url === "/stale/")?.reasons.find((reason) => reason.factor === "review")
      ?.contribution,
    -2,
  );

  const versions = [
    page("/v1/guide/legacy/", { title: "Install", source: "v1/guide/legacy.md" }),
    page("/v2/guide/install/", { title: "Install", source: "v2/guide/install.md" }),
  ];
  const versionTrust = evidence({
    "/v1/guide/legacy/": healthy(),
    "/v2/guide/install/": healthy(),
  });

  const migrate = rankPages(versions, "install", { build: BUILD, task: "migrate", version: "v2", trust: versionTrust });
  const versionReason = (ranked: ReturnType<typeof rankPages>, url: string) =>
    ranked.find((entry) => entry.page.url === url)?.reasons.find((reason) => reason.factor === "version");
  assert.deepEqual(versionReason(migrate, "/v1/guide/legacy/"), {
    factor: "version",
    code: "version:v1",
    contribution: -4,
  });
  assert.deepEqual(versionReason(migrate, "/v2/guide/install/"), {
    factor: "version",
    code: "version:v2",
    contribution: 4,
  });

  const explained = rankPages(versions, "install", {
    build: BUILD,
    task: "explain",
    version: "v2",
    trust: versionTrust,
  });
  assert.equal(versionReason(explained, "/v1/guide/legacy/")?.contribution, -2);

  const statuses = [
    page("/accepted/", { title: "Install", status: "accepted" }),
    page("/deprecated/", { title: "Install", status: "deprecated" }),
  ];
  const statusTrust = evidence({ "/accepted/": healthy(), "/deprecated/": healthy() });
  const statusReason = (ranked: ReturnType<typeof rankPages>) =>
    ranked
      .find((entry) => entry.page.url === "/deprecated/")
      ?.reasons.find((reason) => reason.factor === "trust" && reason.code === "status:deprecated");

  const migrating = rankPages(statuses, "install", { build: BUILD, task: "migrate", trust: statusTrust });
  assert.equal(statusReason(migrating)?.contribution, -4.8);
  const explaining = rankPages(statuses, "install", { build: BUILD, task: "explain", trust: statusTrust });
  assert.equal(statusReason(explaining)?.contribution, -3.6);
});

test("missing, malformed, and cross-build evidence is never verified and never changes order unpredictably", () => {
  const bad = page("/bad/", { title: "Install" });
  const malformed = {
    build: BUILD,
    pages: {
      "/bad/": { examples: { total: 1, passed: 2, failed: 2 }, drift: -3, reviewAgeDays: 10, reviewCoverage: "guessed" },
    },
  } as unknown as RankTrustEvidence;

  const ranked = rankPages([bad], "install", { build: BUILD, task: "implement", trust: malformed });
  const entry = ranked[0]!;
  assert.deepEqual(
    entry.reasons.filter((reason) => ["examples", "drift", "review"].includes(reason.factor)).map((reason) => reason.code),
    ["examples:invalid", "drift:invalid", "review:invalid"],
  );
  assert.ok(
    entry.reasons
      .filter((reason) => ["examples", "drift", "review"].includes(reason.factor))
      .every((reason) => reason.contribution < 0),
    "malformed evidence cannot look verified",
  );
  assert.equal(entry.score, entry.reasons.reduce((sum, reason) => sum + reason.contribution, 0));

  const missing = rankPages([bad], "install", {
    build: BUILD,
    task: "implement",
    trust: evidence({}),
  });
  assert.deepEqual(
    missing[0]?.reasons
      .filter((reason) => ["examples", "drift", "review"].includes(reason.factor))
      .map((reason) => reason.code),
    ["examples:missing", "drift:missing", "review:missing"],
  );

  const pages = [page("/b/", { title: "Install" }), page("/a/", { title: "Install" })];
  const crossBuild = rankPages(pages, "install", {
    build: "another-build",
    task: "implement",
    trust: evidence({ "/a/": healthy(), "/b/": healthy() }),
  });
  const noTrust = rankPages(pages, "install", { task: "implement" });
  const project = (value: ReturnType<typeof rankPages>) =>
    value.map((item) => ({ url: item.page.url, score: item.score, reasons: item.reasons }));
  assert.deepEqual(project(crossBuild), project(noTrust), "another build's evidence is ignored");
  assert.deepEqual(
    crossBuild.map((item) => item.page.url),
    ["/a/", "/b/"],
  );

  const withoutBuild = rankPages(pages, "install", {
    task: "implement",
    trust: evidence({ "/a/": healthy(), "/b/": healthy() }),
  });
  assert.deepEqual(project(withoutBuild), project(noTrust), "evidence without a build identity is ignored");

  const reversed = rankPages([...pages].reverse(), "install", {
    build: "another-build",
    task: "implement",
    trust: evidence({ "/b/": healthy(), "/a/": healthy() }),
  });
  assert.deepEqual(project(reversed), project(crossBuild), "input order cannot reach the result");
});

test("fractional evidence counts are invalid, never truncated into a passing set", () => {
  const target = page("/fraction/", { title: "Install" });
  const fractional = {
    build: BUILD,
    pages: {
      "/fraction/": {
        examples: { total: 1, passed: 0.5, failed: 0.5 },
        drift: 1.5,
        reviewAgeDays: 10.5,
        reviewCoverage: "recorded",
      },
    },
  } as unknown as RankTrustEvidence;

  const entry = rankPages([target], "install", { build: BUILD, task: "implement", trust: fractional })[0]!;
  assert.deepEqual(
    entry.reasons
      .filter((reason) => ["examples", "drift", "review"].includes(reason.factor))
      .map((reason) => reason.code),
    ["examples:invalid", "drift:invalid", "review:invalid"],
  );
  assert.equal(
    entry.reasons.some((reason) => reason.code.startsWith("examples:passed")),
    false,
    "a fractional pass count cannot become a passing example set",
  );
});

test("legacy ranking, dependency-only selection, and multilingual matching survive task and trust options", () => {
  const plain = [
    page("/title/", { title: "Install" }),
    page("/body/", { title: "Other", html: "<p>Install</p>" }),
    page("/none/", { title: "Other" }),
  ];
  const legacy = rankPages(plain, "install");
  assert.deepEqual(
    legacy.map((entry) => entry.score),
    [8, 1, 0],
  );
  assert.deepEqual(
    legacy.map((entry) => entry.page.url),
    ["/title/", "/body/", "/none/"],
  );
  assert.deepEqual(
    rankPages(plain, "install", {}).map((entry) => entry.score),
    legacy.map((entry) => entry.score),
  );

  const dependent = [
    page("/install/", {
      title: "Install",
      source: "install.md",
      html: '<p>Run the engine.</p><a href="/requirements/">Requirements</a>',
    }),
    page("/requirements/", { title: "Requirements", source: "requirements.md" }),
  ];
  const dependentTrust = evidence({ "/install/": healthy(), "/requirements/": healthy() });
  const ranked = rankPages(dependent, "install", { build: BUILD, task: "implement", trust: dependentTrust });
  assert.equal(ranked[0]?.page.url, "/install/");
  assert.equal(ranked[0]?.score, 14);
  const supporting = ranked.find((entry) => entry.page.url === "/requirements/")!;
  assert.ok(Math.abs(supporting.score - 5.6) < 1e-9);
  assert.deepEqual(
    supporting.reasons.find((reason) => reason.factor === "dependency"),
    { factor: "dependency", code: "dependency:/install/", contribution: 3.2 },
  );
  assert.equal(supporting.score, supporting.reasons.reduce((sum, reason) => sum + reason.contribution, 0));

  const persian = [page("/fa/", { title: "می‌رود", source: "fa.md" })];
  const persianRanked = rankPages(persian, "ميرود", {
    build: BUILD,
    task: "implement",
    trust: evidence({ "/fa/": healthy() }),
  });
  assert.ok(persianRanked[0]?.reasons.some((reason) => reason.factor === "lexical"));
  assert.equal(persianRanked[0]?.score, 14);
});

test("bounded negative contributions keep a failing page from scoring below zero while reasons still sum to the score", () => {
  const pages = [
    page("/v1/guide/legacy/", {
      title: "Install",
      source: "v1/guide/legacy.md",
      lang: "fa",
      status: "deprecated",
    }),
    page("/v2/guide/install/", { title: "Install", source: "v2/guide/install.md" }),
  ];
  const trust = evidence({
    "/v1/guide/legacy/": healthy({
      examples: { total: 2, passed: 1, failed: 1 },
      drift: 2,
      reviewAgeDays: 400,
    }),
    "/v2/guide/install/": healthy(),
  });

  const ranked = rankPages(pages, "install", {
    build: BUILD,
    task: "implement",
    version: "v2",
    lang: "en",
    trust,
  });
  assert.equal(ranked[0]?.page.url, "/v2/guide/install/");

  const failing = ranked.find((entry) => entry.page.url === "/v1/guide/legacy/")!;
  assert.ok(failing.score >= -1e-9, "a matching page never scores below zero");
  assert.equal(failing.score, failing.reasons.reduce((sum, reason) => sum + reason.contribution, 0));
  for (const code of [
    "version:v1",
    "status:deprecated",
    "examples:failed:1/2",
    "drift:2",
    "review:overdue:400",
  ]) {
    assert.ok(failing.reasons.some((reason) => reason.code === code), code);
  }
});
