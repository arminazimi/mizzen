import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, SourcePos } from "../src/contracts/index.ts";
import { rankPages, type RankTrustEvidence, type RankTrustPage } from "../src/packs/rank.ts";

function pos(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

function page(url: string, title = "Install"): Page {
  const headings: Heading[] = [];
  return {
    url,
    source: pos("guide/page.md"),
    frontMatter: {},
    title,
    lang: "en",
    dir: "ltr",
    headings,
    html: "",
    markdown: "",
    kind: "doc",
  };
}

/** The build identity the evidence below was measured in. */
const BUILD = "issue-150-build";

function evidence(pages: Readonly<Record<string, RankTrustPage>>): RankTrustEvidence {
  return { build: BUILD, pages };
}

/** The examples reason of a page ranked in a one-page fixture. */
function examplesReason(url: string, examples: NonNullable<RankTrustPage["examples"]>): { code: string; contribution: number } {
  const entry = rankPages([page(url)], "install", {
    build: BUILD,
    trust: evidence({ [url]: { examples } }),
  })[0]!;
  const reason = entry.reasons.find((item) => item.factor === "examples");
  assert.ok(reason !== undefined, url);
  return { code: reason.code, contribution: reason.contribution };
}

test("unrun or unaccounted examples are an explicit incomplete signal, never a passed reason", () => {
  for (const [examples, code] of [
    [{ total: 2, passed: 0, failed: 0 }, "examples:incomplete:0/2"],
    [{ total: 3, passed: 1, failed: 0 }, "examples:incomplete:1/3"],
    [{ total: 4, passed: 3, failed: 0 }, "examples:incomplete:3/4"],
  ] as const) {
    const reason = examplesReason("/guide/incomplete/", examples);
    assert.deepEqual(reason, { code, contribution: 0 }, code);

    const entry = rankPages([page("/guide/incomplete/")], "install", {
      build: BUILD,
      trust: evidence({ "/guide/incomplete/": { examples } }),
    })[0]!;
    assert.equal(
      entry.reasons.some((item) => item.code.startsWith("examples:passed")),
      false,
      "an incomplete set is never reported as passed",
    );
    assert.ok(
      entry.reasons.every((item) => item.factor !== "examples" || item.contribution <= 0),
      "an incomplete set never adds to the score",
    );
    assert.equal(
      entry.score,
      rankPages([page("/guide/incomplete/")], "install", {
        build: BUILD,
        trust: evidence({ "/guide/incomplete/": { examples: "none" } }),
      })[0]!.score,
      "an incomplete set scores exactly like a neutral empty set",
    );
    assert.equal(entry.score, entry.reasons.reduce((sum, item) => sum + item.contribution, 0));
  }
});

test("fully passing, partially failing, empty, malformed, missing, and unknown sets stay distinguishable", () => {
  const malformed = { total: 1, passed: 0.5, failed: 0 } as unknown as NonNullable<RankTrustPage["examples"]>;
  const impossible = { total: 1, passed: 2, failed: 0 };
  const cases: readonly (readonly [string, RankTrustPage["examples"], string, number])[] = [
    ["/full/", { total: 2, passed: 2, failed: 0 }, "examples:passed:2/2", 1.6],
    ["/incomplete/", { total: 3, passed: 2, failed: 0 }, "examples:incomplete:2/3", 0],
    ["/partial-fail/", { total: 3, passed: 1, failed: 1 }, "examples:failed:1/3", -1.6],
    ["/empty-count/", { total: 0, passed: 0, failed: 0 }, "examples:none", 0],
    ["/none/", "none", "examples:none", 0],
    ["/malformed/", malformed, "examples:invalid", -0.8],
    ["/impossible/", impossible, "examples:invalid", -0.8],
    ["/missing/", undefined, "examples:missing", -0.8],
    ["/unknown/", "unknown", "examples:unknown", -0.8],
  ];

  const pages = cases.map(([url]) => page(url));
  const trustPages: Record<string, RankTrustPage> = {};
  for (const [url, examples] of cases) trustPages[url] = examples === undefined ? {} : { examples };
  const ranked = rankPages(pages, "install", {
    build: BUILD,
    trust: evidence(trustPages),
  });

  for (const [url, , code, contribution] of cases) {
    const reason = ranked.find((entry) => entry.page.url === url)?.reasons.find((item) => item.factor === "examples");
    assert.equal(reason?.code, code, url);
    assert.ok(Math.abs((reason?.contribution ?? Number.NaN) - contribution) < 1e-9, `${url} contribution`);
  }

  const codes = new Set(cases.map(([, , code]) => code));
  assert.deepEqual(
    [...codes].sort(),
    [
      "examples:failed:1/3",
      "examples:incomplete:2/3",
      "examples:invalid",
      "examples:missing",
      "examples:none",
      "examples:passed:2/2",
      "examples:unknown",
    ],
    "each example state has its own reason code",
  );

  const score = (url: string) => ranked.find((entry) => entry.page.url === url)!.score;
  assert.ok(score("/full/") > score("/incomplete/"), "a full pass still outranks an incomplete set");
  assert.ok(score("/full/") > score("/partial-fail/"), "a full pass still outranks a failure");
  assert.ok(score("/partial-fail/") < score("/incomplete/"), "a failure demotes more than an incomplete set");
  assert.equal(score("/empty-count/"), score("/none/"), "an empty set is neutral either way it is written");

  for (const entry of ranked) {
    assert.equal(entry.score, entry.reasons.reduce((sum, item) => sum + item.contribution, 0), entry.page.url);
  }
});

test("incomplete evidence cannot outrank equivalent fully passing evidence", () => {
  const pages = [page("/a/"), page("/b/")];
  const ranked = rankPages(pages, "install", {
    build: BUILD,
    trust: evidence({
      "/a/": { examples: { total: 2, passed: 0, failed: 0 } },
      "/b/": { examples: { total: 2, passed: 2, failed: 0 } },
    }),
  });

  assert.deepEqual(
    ranked.map((entry) => entry.page.url),
    ["/b/", "/a/"],
  );
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("incomplete evidence from another build is ignored, exactly like no evidence", () => {
  const pages = [page("/a/"), page("/b/")];
  const project = (ranked: ReturnType<typeof rankPages>) =>
    ranked.map((entry) => ({ url: entry.page.url, score: entry.score, reasons: entry.reasons }));
  const otherBuild: RankTrustEvidence = {
    build: "another-build",
    pages: { "/a/": { examples: { total: 2, passed: 0, failed: 0 } } },
  };

  assert.deepEqual(
    project(rankPages(pages, "install", { build: BUILD, trust: otherBuild })),
    project(rankPages(pages, "install")),
    "cross-build incomplete evidence never reaches the ranking",
  );
});
