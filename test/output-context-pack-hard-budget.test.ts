import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { contextPack, warningOf, type PackEvidence } from "../src/outputs/context-pack.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "../src/packs/tokens.ts";

/**
 * Issue #113: configured packs in `_data/context-packs.yml` must get the same honest hard-budget
 * behavior as ad-hoc context requests. A pack may only report that it fits when the estimator's
 * documented margin still leaves the exact final Markdown inside the topic budget; when even the
 * mandatory content cannot fit, the pack keeps it whole and publishes the over-budget warning with
 * accurate minimum, remaining, and accounting values, and both twins select identical content.
 */

/** The warning ids that explicitly diagnose a pack as over budget. */
const OVER_BUDGET_IDS = new Set([
  "pack.trim.over-budget",
  "pack.trim.required-over-budget",
  "context-pack.over-budget",
]);

function isOverBudgetDiagnosed(evidence: PackEvidence): boolean {
  return evidence.warnings.some((warning) => OVER_BUDGET_IDS.has(warning.id));
}

/** The sum of a rank's contributions: the score a reader can check. */
function contributionSum(reasons: readonly { readonly contribution: number }[]): number {
  return reasons.reduce((sum, reason) => sum + reason.contribution, 0);
}

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
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
    ...overrides,
  };
}

interface PageOptions {
  readonly title?: string;
  readonly source?: string;
}

function page(url: string, markdown: string, options: PageOptions = {}): Page {
  return {
    url,
    source: { file: options.source ?? "guide/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: options.title ?? "Page",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
  return { config: config(), pages, nav: {}, data };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: { renderPage: () => Promise.resolve(""), report: (diagnostic) => void diagnostics.push(diagnostic) },
  };
}

/** The Markdown pack among the files. */
function markdownOf(files: readonly OutputFile[]): string {
  const found = files.filter((file) => file.path.endsWith(".md"));
  assert.equal(found.length, 1, "one Markdown pack");
  return String(found[0]!.contents);
}

/** The structured twin of the pack, parsed. */
function evidenceOf(files: readonly OutputFile[]): PackEvidence {
  const found = files.filter((file) => file.path.endsWith(".json"));
  assert.equal(found.length, 1, "one structured pack");
  return JSON.parse(String(found[0]!.contents)) as PackEvidence;
}

const INSTALL = `# Install the engine

Install the engine before you configure the site. Install once per machine.

## Requirements

You need Node 24 or newer and a terminal to install.

## Steps

Run the installer and follow the prompts to install.

## Troubleshooting

If the installer fails, read the log.
`;

const DEPLOY = `# Deploy the site

Deploy the built site behind a proxy.

## Build

Run the build and deploy the output folder.

## Rollback

Restore the previous release if a deploy fails.
`;

/** Two ranked candidates: the deploy page joins only when the budget honestly allows it. */
function twoPageSite(budget: number): Site {
  return site(
    [
      page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
      page("/guide/deploy/", DEPLOY, { title: "Deploy the site", source: "guide/deploy.md" }),
    ],
    { contextPacks: [{ topic: "Release", query: "install deploy", budget }] },
  );
}

test("a budget sweep never reports a fit while the final bytes' upper bound exceeds the budget", async () => {
  const overBudgetCount: number[] = [];
  const checked: number[] = [];
  for (let budget = 40; budget <= 240; budget += 5) {
    const model = twoPageSite(budget);
    const { ctx, diagnostics } = context();
    const files = await contextPack.run(model, ctx);
    const markdown = markdownOf(files);
    const evidence = evidenceOf(files);
    const exact = estimateTokens(markdown);
    const overBudget = isOverBudgetDiagnosed(evidence);

    assert.ok(evidence.items.length >= 1, `budget ${budget}: a ranked topic writes a pack`);
    assert.deepEqual(
      evidence.warnings,
      diagnostics.map(warningOf),
      `budget ${budget}: the JSON publishes exactly the warnings the build reports`,
    );
    assert.equal(exact.method, TOKEN_METHOD);
    assert.equal(evidence.accounting.method, TOKEN_METHOD);
    assert.equal(evidence.accounting.margin, TOKEN_ERROR_MARGIN, `budget ${budget}: the documented margin is published`);
    assert.equal(evidence.accounting.requested, budget);
    assert.equal(evidence.accounting.used, exact.tokens, `budget ${budget}: used prices the exact final Markdown`);
    assert.equal(
      evidence.accounting.upper,
      Math.ceil(exact.tokens * (1 + TOKEN_ERROR_MARGIN)),
      `budget ${budget}: upper grows the exact final Markdown's estimate by the documented margin`,
    );
    assert.equal(
      evidence.accounting.selected + evidence.accounting.required + evidence.accounting.overhead,
      evidence.accounting.used,
      `budget ${budget}: no cost is hidden`,
    );
    assert.equal(evidence.accounting.remaining, budget - evidence.accounting.used, `budget ${budget}: remaining is exact`);

    if (overBudget) {
      overBudgetCount.push(budget);
      assert.ok(evidence.accounting.minimum !== null, `budget ${budget}: an over-budget pack publishes its minimum`);
      assert.ok(
        evidence.accounting.minimum.upper > budget,
        `budget ${budget}: the minimum's upper bound exceeds the budget, so no feasible result exists`,
      );
      assert.equal(
        evidence.accounting.upper,
        evidence.accounting.minimum.upper,
        `budget ${budget}: only the mandatory content survives, so the pack is its own minimum`,
      );
    } else {
      checked.push(budget);
      assert.ok(
        evidence.accounting.upper <= budget,
        `budget ${budget}: a pack reported as fitting must satisfy upper (${evidence.accounting.upper}) <= budget`,
      );
      assert.equal(evidence.accounting.minimum, null, `budget ${budget}: a fitting pack has no over-budget minimum`);
      assert.ok(evidence.accounting.remaining >= 0, `budget ${budget}: a fitting pack leaves non-negative remaining`);
    }
  }
  assert.ok(checked.length > 0, "the sweep checks budgets reported as fitting, not only diagnosed ones");
  assert.ok(overBudgetCount.length > 0, "the sweep also walks budgets diagnosed as over budget");
});

test("the pack reported as fitting stays inside the budget when point estimates alone would fit", async () => {
  // At this budget the point estimate of the whole pack fits, but its upper bound exceeds the
  // budget; the hard trimming mode must drop the last optional section instead of reporting a fit.
  const budget = 100;
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget }] },
  );
  const { ctx, diagnostics } = context();
  const files = await contextPack.run(model, ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);
  const exact = estimateTokens(markdown);

  assert.deepEqual(diagnostics, [], "a pack that fits honestly reports nothing");
  assert.deepEqual(evidence.warnings, []);
  assert.ok(evidence.accounting.upper <= budget, `upper ${evidence.accounting.upper} must fit ${budget}`);
  assert.ok(exact.tokens <= budget);
  assert.match(markdown, /Install the engine before you configure the site/);
  assert.match(markdown, /## Requirements/);
  assert.match(markdown, /## Steps/);
  assert.doesNotMatch(markdown, /## Troubleshooting/, "the section that broke the upper bound is dropped");
  assert.equal(evidence.accounting.minimum, null);
});

test("an optional page joins only when its mandatory content fits the planning upper bound", async () => {
  // The second page's mandatory lead would put the pack's upper bound over this budget, so it is
  // omitted with its rank evidence instead of silently exceeding the budget.
  const budget = 89;
  const model = twoPageSite(budget);
  const { ctx, diagnostics } = context();
  const files = await contextPack.run(model, ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(evidence.items.map((item) => item.id), ["/guide/install/"]);
  assert.ok(evidence.accounting.upper <= budget, `upper ${evidence.accounting.upper} must fit ${budget}`);

  assert.deepEqual(
    evidence.selection.omitted.map((omission) => omission.id),
    ["/guide/deploy/"],
  );
  const omitted = evidence.selection.omitted[0]!;
  assert.equal(omitted.reason, "budget");
  assert.ok(omitted.score > 0, "the omission carries the score the page ranked with");
  assert.equal(contributionSum(omitted.reasons), omitted.score, "the omission's reasons sum to its score");
  assert.ok(omitted.span.startsWith("guide/deploy.md:"));
  assert.doesNotMatch(markdown, /## Deploy the site/, "the omitted page is not in the Markdown either");
  assert.doesNotMatch(markdown, /Deploy the built site/);
});

test("an impossible budget keeps the mandatory lead whole and publishes exact minimum values", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const { ctx, diagnostics } = context();
  const files = await contextPack.run(model, ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);
  const exact = estimateTokens(markdown);
  const accounting = evidence.accounting;

  assert.match(markdown, /Install the engine before you configure the site/, "the lead survives");
  assert.doesNotMatch(markdown, /You need Node 24/, "every optional section is dropped");
  assert.ok(diagnostics.some((diagnostic) => diagnostic.id === "pack.trim.over-budget"), "the over budget warning is reported");
  assert.deepEqual(evidence.warnings, diagnostics.map(warningOf));
  assert.ok(isOverBudgetDiagnosed(evidence));

  assert.ok(accounting.used > accounting.requested);
  assert.equal(accounting.used, exact.tokens, "used prices the exact final bytes even when over budget");
  assert.equal(accounting.remaining, 1 - accounting.used, "remaining honestly shows how far over the pack is");
  assert.ok(accounting.minimum !== null, "an impossible budget publishes the smallest feasible cost");
  assert.equal(
    accounting.minimum.tokens,
    accounting.selected + accounting.required + accounting.overhead,
    "the minimum is the serialization that survives, which is mandatory-only here",
  );
  assert.equal(accounting.minimum.upper, Math.ceil(accounting.minimum.tokens * (1 + TOKEN_ERROR_MARGIN)));
  assert.equal(accounting.reserved, accounting.minimum.upper);
  assert.equal(accounting.upper, accounting.minimum.upper, "the pack cannot get smaller than its minimum");

  assert.deepEqual(
    evidence.selection.omissions.map((omission) => [omission.text, omission.reason]),
    [
      ["Requirements", "budget"],
      ["Steps", "budget"],
      ["Troubleshooting", "budget"],
    ],
  );
});

test("both twins select identical content when the budget trims several pages", async () => {
  const budget = 120;
  const model = twoPageSite(budget);
  const { ctx, diagnostics } = context();
  const files = await contextPack.run(model, ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);

  assert.deepEqual(diagnostics, [], `budget ${budget} has a feasible hard-budget result`);
  assert.ok(evidence.accounting.upper <= budget);

  let cursor = 0;
  for (const item of evidence.items) {
    const header = markdown.indexOf(`## ${item.title}`, cursor);
    assert.ok(header >= 0, `the Markdown names ${item.id} after the previous item`);
    const source = markdown.indexOf(`- Source: \`${item.origin.source}\``, header);
    assert.ok(source > header, "and the same source line");
    if (item.content !== "") {
      const body = markdown.indexOf(item.content, source);
      assert.ok(body > source, `the Markdown shows exactly ${item.id}'s selected body`);
    }
    cursor = source;

    const kept = item.sections.map((section) => section.text);
    const dropped = evidence.selection.omissions
      .filter((omission) => omission.item === item.id)
      .map((omission) => omission.text);
    for (const text of kept) {
      assert.ok(markdown.includes(`## ${text}`), `the kept section ${text} is shown`);
      assert.equal(
        evidence.selection.omissions.some((omission) => omission.text === text && omission.reason === "budget"),
        false,
        "a kept section is never also reported as budget-omitted",
      );
    }
    for (const text of dropped) {
      assert.equal(markdown.includes(`## ${text}\n`), false, `the omitted section ${text} is not shown`);
    }
    for (const omission of evidence.selection.omissions.filter((entry) => entry.item === item.id)) {
      assert.ok(omission.tokens > 0, "every omitted section prices itself");
      assert.ok(omission.span.startsWith(`${item.origin.source}:`), "and points at its source");
    }
  }

  const titles = new Map([
    ["/guide/install/", "Install the engine"],
    ["/guide/deploy/", "Deploy the site"],
  ]);
  const omittedPages = evidence.selection.omitted.map((omission) => omission.id);
  for (const item of evidence.items) {
    assert.equal(omittedPages.includes(item.id), false, "a page is selected or omitted, never both");
  }
  for (const omission of evidence.selection.omitted) {
    assert.equal(omission.reason, "budget");
    assert.ok(!markdown.includes(`## ${titles.get(omission.id) ?? omission.id}`), `${omission.id} is not in the Markdown`);
  }

  const again = await contextPack.run(model, context().ctx);
  assert.deepEqual(again, files, "the honest hard budget stays deterministic");
});
