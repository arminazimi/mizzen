import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, SourcePos } from "../src/contracts/index.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN } from "../src/packs/tokens.ts";
import { trimPages } from "../src/packs/trim.ts";

function pos(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

function page(url: string, markdown: string, source = "guide/install.md", line = 1): Page {
  return {
    url,
    source: { file: source, line, column: 1, endLine: line, endColumn: 1 },
    frontMatter: {},
    title: "Install the engine",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The estimator's planning upper bound for a text, the measure hard mode enforces. */
function upperOf(text: string): number {
  return Math.ceil(estimateTokens(text).tokens * (1 + TOKEN_ERROR_MARGIN));
}

/** The canonical serialization: parts joined with one blank line, non-empty parts only. */
function serialize(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

/** A page with a title, an intro paragraph, and three optional sections. */
const PAGE = `# Install the engine

Install the engine before you configure the site.

## Requirements

You need Node 24 or newer and a terminal.

## Steps

Run the installer and follow the prompts.

## Troubleshooting

If the installer fails, read the log.
`;

const LEAD = "# Install the engine\n\nInstall the engine before you configure the site.";

const EVIDENCE = [
  { id: "source", kind: "source", text: "- Source: `guide/install.md`" },
  { id: "version", kind: "version", text: "- Version: 0.1.0" },
  { id: "warning", kind: "warning", text: "> Warning: the installer API is deprecated.", pos: pos("guide/install.md") },
] as const;

/** Three ranked pages of the same shape, each with two optional sections. */
const THREE = ["One", "Two", "Three"].map((name) => {
  const markdown = `# ${name}

First paragraph of ${name.toLowerCase()}.

## A

Alpha detail for ${name.toLowerCase()}.

## B

Beta detail for ${name.toLowerCase()}.`;
  return {
    name,
    markdown,
    lead: `# ${name}\n\nFirst paragraph of ${name.toLowerCase()}.`,
    first: `## A\n\nAlpha detail for ${name.toLowerCase()}.`,
    second: `## B\n\nBeta detail for ${name.toLowerCase()}.`,
  };
});

test("hard mode fits when the whole serialization's upper bound is within the budget", async () => {
  const pages = [page("/guide/one/", PAGE, "guide/one.md")];
  const full = serialize([...EVIDENCE.map((item) => item.text), PAGE]);
  const budget = upperOf(full);

  const result = await trimPages(pages, budget, { mode: "hard", required: EVIDENCE });

  assert.equal(result.status, "fits");
  assert.equal(result.markdown, full, "everything is kept when the upper bound fits");
  assert.ok(result.accounting.upper <= budget, `${result.accounting.upper} against a budget of ${budget}`);
  assert.equal(result.accounting.upper, upperOf(result.markdown), "upper prices the complete serialization");
  assert.equal(result.accounting.upper, Math.ceil(result.accounting.tokens * (1 + TOKEN_ERROR_MARGIN)));
  assert.equal(result.accounting.limit, budget);
  assert.ok(result.accounting.remaining >= 0);
  assert.equal(result.overBudget, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.omissions, []);
});

test("hard mode drops optional sections until the upper bound fits, never the estimate", async () => {
  const pages = [page("/guide/install/", PAGE)];
  const full = upperOf(PAGE);
  const budget = full - 1;

  const result = await trimPages(pages, budget, { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= budget, `${result.accounting.upper} against a budget of ${budget}`);
  assert.ok(result.accounting.tokens < result.accounting.upper, "the estimate is below the planning bound");
  assert.ok(result.omissions.length > 0);
  assert.ok(result.omissions.every((omission) => omission.reason === "budget"));
  assert.deepEqual(
    result.pages[0]?.keptSections.map((section) => section.text),
    ["Requirements", "Steps"],
  );
  assert.deepEqual(
    result.pages[0]?.droppedSections.map((section) => section.text),
    ["Troubleshooting"],
  );
});

test("reserved tokens are withheld from optional content, even when no required evidence uses them", async () => {
  const full = upperOf(PAGE);
  const budget = full;
  const reserved = Math.floor(full / 2);
  const limit = budget - reserved;

  assert.ok(upperOf(LEAD) <= limit, "the mandatory lead fits the reduced limit");
  assert.ok(upperOf(PAGE) > limit, "the whole page would only fit if the reserve were spent");

  const withReserve = await trimPages([page("/guide/install/", PAGE)], budget, {
    mode: "hard",
    reservedTokens: reserved,
  });
  const withoutReserve = await trimPages([page("/guide/install/", PAGE)], limit, { mode: "hard" });

  assert.equal(withReserve.status, "fits");
  assert.equal(withReserve.accounting.budget, budget);
  assert.equal(withReserve.accounting.reserved, reserved);
  assert.equal(withReserve.accounting.limit, limit);
  assert.ok(withReserve.accounting.upper <= limit);
  assert.ok(withReserve.omissions.length > 0, "the reserve is not handed to optional sections");
  assert.equal(withReserve.markdown, withoutReserve.markdown);
  assert.deepEqual(
    withReserve.pages[0]?.keptSections.map((section) => section.text),
    withoutReserve.pages[0]?.keptSections.map((section) => section.text),
  );
});

test("reserved tokens stay withheld when required evidence is smaller than the reserve", async () => {
  const evidenceText = serialize(EVIDENCE.map((item) => item.text));
  const evidenceUpper = upperOf(evidenceText);
  const fixed = serialize([evidenceText, LEAD]);
  const full = serialize([evidenceText, PAGE]);
  const reserved = evidenceUpper + 5;
  const budget = upperOf(fixed) + reserved + 5;
  const limit = budget - reserved;
  const pages = [page("/guide/install/", PAGE)];

  assert.ok(evidenceUpper < reserved, "the evidence is smaller than the reserve");
  assert.ok(upperOf(fixed) <= limit, "the fixed content fits the reduced limit");
  assert.ok(upperOf(full) > limit, "the whole page would only fit if the reserve were spent");

  const withEvidence = await trimPages(pages, budget, { mode: "hard", reservedTokens: reserved, required: EVIDENCE });
  const withoutReserve = await trimPages(pages, limit, { mode: "hard", required: EVIDENCE });

  assert.equal(withEvidence.status, "fits");
  assert.equal(withEvidence.accounting.limit, limit);
  assert.ok(withEvidence.accounting.upper <= limit);
  assert.ok(withEvidence.omissions.length > 0);
  assert.equal(withEvidence.markdown, withoutReserve.markdown);
  assert.deepEqual(
    withEvidence.pages[0]?.keptSections.map((section) => section.text),
    withoutReserve.pages[0]?.keptSections.map((section) => section.text),
  );
});

test("partial pages share the budget in equal turns, with rank order as the tie-break", async () => {
  const pages = THREE.map((entry) => page(`/guide/${entry.name.toLowerCase()}/`, entry.markdown, `guide/${entry.name.toLowerCase()}.md`));
  const firstRound = serialize(THREE.map((entry) => `${entry.lead}\n\n${entry.first}`));
  const budget = upperOf(firstRound);

  const result = await trimPages(pages, budget, { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= budget, `${result.accounting.upper} against a budget of ${budget}`);
  assert.equal(result.markdown, firstRound, "every page gets one turn before any page gets a second");
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["A"], ["A"], ["A"]],
  );
  assert.deepEqual(
    result.pages.map((entry) => entry.droppedSections.map((section) => section.text)),
    [["B"], ["B"], ["B"]],
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason]),
    [
      ["/guide/one/", "B", "budget"],
      ["/guide/two/", "B", "budget"],
      ["/guide/three/", "B", "budget"],
    ],
  );
});

test("when only some pages fit, the lowest-ranked page gives way first and the result is stable", async () => {
  const pages = THREE.map((entry) => page(`/guide/${entry.name.toLowerCase()}/`, entry.markdown, `guide/${entry.name.toLowerCase()}.md`));
  const twoTurns = serialize([
    `${THREE[0]!.lead}\n\n${THREE[0]!.first}`,
    `${THREE[1]!.lead}\n\n${THREE[1]!.first}`,
    THREE[2]!.lead,
  ]);
  const budget = upperOf(twoTurns);

  const first = await trimPages(pages, budget, { mode: "hard" });
  const second = await trimPages(pages, budget, { mode: "hard" });

  assert.deepEqual(second, first, "the same input gives byte-identical output");
  assert.equal(first.status, "fits");
  assert.equal(first.markdown, twoTurns);
  assert.deepEqual(
    first.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["A"], ["A"], []],
    "rank order breaks the tie for the last turn",
  );
  assert.deepEqual(
    first.omissions.map((omission) => [omission.url, omission.text, omission.reason]),
    [
      ["/guide/one/", "B", "budget"],
      ["/guide/two/", "B", "budget"],
      ["/guide/three/", "A", "budget"],
      ["/guide/three/", "B", "budget"],
    ],
    "every dropped section is reported, including both sections of the page that got no turn",
  );
});

test("an impossible hard budget is reported with the exact minimum and required upper bounds", async () => {
  const pages = [page("/guide/install/", PAGE)];
  const fixed = serialize([...EVIDENCE.map((item) => item.text), LEAD]);
  const minimumUpper = upperOf(fixed);
  const requiredUpper = upperOf(serialize([...EVIDENCE.map((item) => item.text), LEAD]));
  const budget = 1;

  const result = await trimPages(pages, budget, { mode: "hard", required: EVIDENCE });

  assert.equal(result.status, "over-budget", "mandatory requirements never report a false fit");
  assert.ok(result.overBudget !== undefined);
  assert.equal(result.overBudget.limit, budget);
  assert.equal(result.overBudget.minimumUpper, minimumUpper);
  assert.equal(result.overBudget.requiredUpper, requiredUpper);
  assert.equal(result.overBudget.missingUpper, minimumUpper - budget);
  assert.equal(result.accounting.minimumUpper, minimumUpper);
  assert.equal(result.accounting.requiredUpper, requiredUpper);
  assert.equal(result.accounting.upper, minimumUpper, "nothing optional is kept");
  assert.ok(result.accounting.upper > budget);
  assert.equal(result.markdown, fixed);
  assert.deepEqual(
    result.omissions.map((omission) => [omission.text, omission.reason]),
    [
      ["Requirements", "budget"],
      ["Steps", "budget"],
      ["Troubleshooting", "budget"],
    ],
  );
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "pack.trim.required-over-budget");
  assert.equal(result.diagnostics[0]?.severity, "warning");
});

test("a pinned section is kept in an impossible hard budget and is part of the minimum", async () => {
  const pages = [page("/guide/install/", PAGE)];
  const pinned = `## Troubleshooting\n\nIf the installer fails, read the log.`;
  const fixed = `${LEAD}\n\n${pinned}`;
  const minimumUpper = upperOf(fixed);

  const result = await trimPages(pages, 1, { mode: "hard", keep: ["Troubleshooting"] });

  assert.equal(result.status, "over-budget");
  assert.ok(result.overBudget !== undefined);
  assert.equal(result.overBudget.minimumUpper, minimumUpper);
  assert.equal(result.accounting.minimumUpper, minimumUpper);
  assert.equal(result.markdown, fixed);
  assert.deepEqual(
    result.pages[0]?.keptSections.map((section) => section.text),
    ["Troubleshooting"],
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.text, omission.reason]),
    [
      ["Requirements", "budget"],
      ["Steps", "budget"],
    ],
  );
});

test("duplicate omissions keep their reason in hard mode", async () => {
  const DEPLOY = `## Deploy

Build the site, copy the output directory to the server, restart the service, clear the cache, open the home page, follow the first three links, confirm every page loads without an error, and note the version that is reported in the footer.`;
  const pages = [
    page("/guide/alpha/", `# Alpha\n\nAlpha intro.\n\n${DEPLOY}`, "guide/alpha.md"),
    page("/guide/beta/", `# Beta\n\nBeta intro.\n\n${DEPLOY}`, "guide/beta.md"),
  ];

  const result = await trimPages(pages, 10_000, { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["Deploy"], []],
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.reason, omission.duplicateOf?.url]),
    [["/guide/beta/", "duplicate", "/guide/alpha/"]],
  );
  assert.ok(result.accounting.upper <= result.accounting.limit);
});

test("a custom estimator has no margin, and hard mode uses it as the upper bound", async () => {
  const width = (text: string): number => text.length;
  const pages = [page("/guide/install/", PAGE)];

  const fits = await trimPages(pages, 10_000, { mode: "hard", estimate: width });
  assert.equal(fits.status, "fits");
  assert.equal(fits.accounting.method, "custom");
  assert.equal(fits.accounting.margin, 0);
  assert.equal(fits.accounting.upper, fits.accounting.tokens);

  const lead = "# Install the engine\n\nInstall the engine before you configure the site.";
  const trimmed = await trimPages(pages, lead.length, { mode: "hard", estimate: width });
  assert.equal(trimmed.status, "fits");
  assert.equal(trimmed.markdown, lead);
  assert.equal(trimmed.accounting.upper, lead.length);
  assert.deepEqual(trimmed.pages[0]?.keptSections, []);
});

test("the default mode keeps its previous output bytes, accounting, and omissions", async () => {
  const pages = [page("/guide/install/", PAGE)];
  const leadAndFirst = `${LEAD}\n\n## Requirements\n\nYou need Node 24 or newer and a terminal.`;
  const budget = estimateTokens(leadAndFirst).tokens;

  const result = await trimPages(pages, budget);

  assert.equal(result.markdown, leadAndFirst);
  assert.equal(result.pages[0]?.markdown, leadAndFirst);
  assert.deepEqual(
    result.pages[0]?.keptSections.map((section) => section.text),
    ["Requirements"],
  );
  assert.deepEqual(
    result.omissions.map((omission) => omission.text),
    ["Steps", "Troubleshooting"],
  );
  assert.equal(result.accounting.budget, budget);
  assert.equal(result.accounting.reserved, 0);
  assert.equal(result.accounting.limit, budget);
  assert.equal(result.accounting.tokens, estimateTokens(leadAndFirst).tokens);
  assert.equal(result.accounting.upper, upperOf(leadAndFirst));
  assert.ok(result.accounting.remaining <= budget);
  assert.equal(result.status, "fits");
  assert.equal(result.overBudget, undefined);
  assert.deepEqual(result.diagnostics, []);
});
