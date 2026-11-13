/**
 * M5.16: the ad-hoc pack compiler must give an honest hard budget.
 *
 * A compiled pack may only report that it fits when the estimator's documented margin still leaves the
 * exact final Markdown inside the request's budget. Page removal and final acceptance therefore read the
 * upper bound of the exact bytes, the title, headers, and separators included. When even the required
 * and mandatory content cannot fit, the pack keeps it whole, publishes the over-budget warning, and
 * states the smallest feasible cost. The Markdown and JSON twins always name the same selection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextRequest } from "../src/contracts/context-request.ts";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { warningOf, type PackEvidence } from "../src/outputs/context-pack.ts";
import { compilePack } from "../src/packs/compile.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "../src/packs/tokens.ts";

/** The warning ids that explicitly diagnose a pack as over budget. */
const OVER_BUDGET_IDS = new Set([
  "pack.trim.over-budget",
  "pack.trim.required-over-budget",
  "context-pack.over-budget",
]);

function isOverBudgetDiagnosed(evidence: PackEvidence): boolean {
  return evidence.warnings.some((warning) => OVER_BUDGET_IDS.has(warning.id));
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

function page(url: string, markdown: string, title: string, source: string): Page {
  return {
    url,
    source: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
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

/** Two ranked candidates; the deploy page joins only when the budget honestly allows it. */
function twoPageSite(): Site {
  return {
    config: config(),
    pages: [
      page("/guide/install/", INSTALL, "Install the engine", "guide/install.md"),
      page("/guide/deploy/", DEPLOY, "Deploy the site", "guide/deploy.md"),
    ],
    nav: {},
    data: {},
  };
}

/** A request for both pages, at the given budget. */
function request(maxTokens: number, extra: Partial<ContextRequest> = {}): ContextRequest {
  return {
    version: 1,
    task: { goal: "install deploy" },
    include: [],
    exclude: [],
    constraints: {},
    budget: { maxTokens },
    requiredEvidence: { refs: [], source: false, versions: false, warnings: false, dependencies: false },
    ...extra,
  };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: { renderPage: () => Promise.resolve(""), report: (diagnostic) => void diagnostics.push(diagnostic) },
  };
}

test("a budget sweep never reports a fit while the exact final Markdown's upper bound exceeds the budget", async () => {
  const fitted: number[] = [];
  const overBudget: number[] = [];

  for (let budget = 40; budget <= 240; budget += 5) {
    const { ctx, diagnostics } = context();
    const compiled = await compilePack(twoPageSite(), request(budget), ctx);
    assert.ok(compiled, `budget ${budget}: the request selects pages`);
    const { evidence, markdown } = compiled;
    const exact = estimateTokens(markdown);
    const accounting = evidence.accounting;

    assert.ok(evidence.items.length >= 1, `budget ${budget}: a ranked goal writes a pack`);
    assert.deepEqual(
      evidence.warnings,
      diagnostics.map(warningOf),
      `budget ${budget}: the JSON publishes exactly the warnings the build reports`,
    );
    assert.equal(accounting.method, TOKEN_METHOD);
    assert.equal(accounting.margin, TOKEN_ERROR_MARGIN, `budget ${budget}: the documented margin is published`);
    assert.equal(accounting.requested, budget);
    assert.equal(accounting.used, exact.tokens, `budget ${budget}: used prices the exact final Markdown`);
    assert.equal(
      accounting.upper,
      Math.ceil(exact.tokens * (1 + TOKEN_ERROR_MARGIN)),
      `budget ${budget}: upper grows the exact final Markdown's estimate by the documented margin`,
    );
    assert.equal(
      accounting.selected + accounting.required + accounting.overhead,
      accounting.used,
      `budget ${budget}: no cost is hidden`,
    );
    assert.equal(accounting.remaining, budget - accounting.used, `budget ${budget}: remaining is exact`);

    if (isOverBudgetDiagnosed(evidence)) {
      overBudget.push(budget);
      assert.deepEqual(evidence.warnings, diagnostics.map(warningOf));
      assert.ok(accounting.minimum !== null, `budget ${budget}: an over-budget pack publishes its minimum`);
      assert.ok(
        accounting.minimum.upper > budget,
        `budget ${budget}: the minimum's upper bound exceeds the budget, so no feasible result exists`,
      );
      assert.equal(
        accounting.upper,
        accounting.minimum.upper,
        `budget ${budget}: only the fixed content survives, so the pack is its own minimum`,
      );
      assert.equal(
        accounting.minimum.tokens,
        accounting.used,
        `budget ${budget}: the published minimum is the serialization that survives`,
      );
    } else {
      fitted.push(budget);
      assert.ok(
        accounting.upper <= budget,
        `budget ${budget}: a pack reported as fitting must satisfy upper (${accounting.upper}) <= budget`,
      );
      assert.equal(accounting.minimum, null, `budget ${budget}: a fitting pack has no over-budget minimum`);
      assert.ok(accounting.remaining >= 0, `budget ${budget}: a fitting pack leaves non-negative remaining`);
    }

    // The Markdown and the JSON are two renderings of one selection, never two answers.
    let cursor = 0;
    for (const item of evidence.items) {
      const header = markdown.indexOf(`## ${item.title}`, cursor);
      assert.ok(header >= 0, `budget ${budget}: the Markdown names ${item.id} in the JSON's order`);
      if (item.content !== "") {
        const body = markdown.indexOf(item.content, header);
        assert.ok(body > header, `budget ${budget}: the Markdown shows exactly ${item.id}'s selected content`);
      }
      cursor = header;
    }
    for (const omission of evidence.selection.omitted) {
      const title = omission.id === "/guide/deploy/" ? "Deploy the site" : "Install the engine";
      assert.equal(
        markdown.includes(`## ${title}\n`),
        false,
        `budget ${budget}: the omitted page ${omission.id} is not in the Markdown`,
      );
    }
  }

  assert.ok(fitted.length > 0, "the sweep checks budgets reported as fitting, not only diagnosed ones");
  assert.ok(overBudget.length > 0, "the sweep also walks budgets diagnosed as over budget");
});

test("an optional page no longer survives on a point estimate alone", async () => {
  // At this budget the point estimate of the two-page pack fits (91 tokens at 90), but its upper
  // bound does not; the deploy page must give way instead of silently exceeding the budget.
  const budget = 90;
  const { ctx, diagnostics } = context();
  const compiled = await compilePack(twoPageSite(), request(budget), ctx);
  assert.ok(compiled);
  const { evidence, markdown } = compiled;

  assert.deepEqual(diagnostics, [], "a pack that fits honestly reports nothing");
  assert.deepEqual(evidence.warnings, []);
  assert.deepEqual(evidence.items.map((item) => item.id), ["/guide/install/"]);
  assert.ok(evidence.accounting.upper <= budget, `upper ${evidence.accounting.upper} must fit ${budget}`);
  assert.equal(evidence.accounting.minimum, null);

  assert.deepEqual(
    evidence.selection.omitted.map((omission) => omission.id),
    ["/guide/deploy/"],
  );
  assert.equal(evidence.selection.omitted[0]!.reason, "budget");
  assert.doesNotMatch(markdown, /## Deploy the site/, "the omitted page is not in the Markdown either");
});

test("an impossible budget keeps required and mandatory content whole and publishes truthful values", async () => {
  const budget = 1;
  const { ctx, diagnostics } = context();
  const compiled = await compilePack(
    twoPageSite(),
    request(budget, {
      include: ["guide/install.md"],
      requiredEvidence: {
        refs: ["guide/install.md:9:1"],
        source: true,
        versions: true,
        warnings: false,
        dependencies: false,
      },
    }),
    ctx,
  );
  assert.ok(compiled);
  const { evidence, markdown } = compiled;
  const exact = estimateTokens(markdown);
  const accounting = evidence.accounting;

  assert.match(markdown, /Install the engine before you configure the site/, "the mandatory lead survives");
  assert.match(markdown, /- Source span: `guide\/install\.md:/, "required source evidence survives");
  assert.match(markdown, /- Version: current; locale: en/, "required version evidence survives");
  assert.match(markdown, /## Steps/, "the pinned section survives");
  assert.doesNotMatch(markdown, /## Requirements/, "every optional section is dropped");
  assert.doesNotMatch(markdown, /## Troubleshooting/);

  assert.deepEqual(evidence.warnings, diagnostics.map(warningOf));
  assert.ok(isOverBudgetDiagnosed(evidence), "the over-budget condition is explicit");
  assert.equal(accounting.used, exact.tokens, "used prices the exact final bytes even when over budget");
  assert.equal(accounting.remaining, budget - accounting.used, "remaining honestly shows how far over the pack is");
  assert.ok(accounting.remaining < 0);
  assert.ok(accounting.minimum !== null, "an impossible budget publishes the smallest feasible cost");
  assert.equal(accounting.minimum.tokens, accounting.used, "the least that keeps the required content is the result");
  assert.equal(accounting.minimum.upper, accounting.upper);
  assert.ok(accounting.upper > budget);
  assert.equal(accounting.reserved, accounting.minimum.upper);

  assert.deepEqual(
    evidence.selection.omissions.map((omission) => [omission.text, omission.reason]),
    [
      ["Requirements", "budget"],
      ["Troubleshooting", "budget"],
    ],
  );
  for (const item of evidence.items) {
    assert.ok(markdown.includes(item.content), `the Markdown shows ${item.id}'s JSON content`);
  }
});
