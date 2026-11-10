import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, SourcePos } from "../src/contracts/index.ts";
import { estimateTokens } from "../src/packs/tokens.ts";
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

/** A page with a title heading, an intro paragraph, and three trailing sections. */
const PAGE = `# Install the engine

Install the engine before you configure the site.

## Requirements

You need Node 24 or newer and a terminal.

## Steps

Run the installer and follow the prompts.

## Troubleshooting

If the installer fails, read the log.
`;

/** The page's lead plus its first section: what has to survive the smallest fitting budget. */
const LEAD_AND_FIRST = `# Install the engine

Install the engine before you configure the site.

## Requirements

You need Node 24 or newer and a terminal.`;

test("a page that fits the budget is returned byte for byte", async () => {
  const result = await trimPages([page("/guide/install/", PAGE, "guide/install.md")], estimateTokens(PAGE).tokens + 50);

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]?.markdown, PAGE);
  assert.deepEqual(
    result.pages[0]?.keptSections.map((section) => section.text),
    ["Requirements", "Steps", "Troubleshooting"],
  );
  assert.deepEqual(result.pages[0]?.droppedSections, []);
  assert.equal(result.pages[0]?.tokens, estimateTokens(PAGE).tokens);
  assert.deepEqual(result.diagnostics, []);
});

test("trailing sections are dropped, from the last page's last section, until the budget is met", async () => {
  const budget = estimateTokens(LEAD_AND_FIRST).tokens;
  const result = await trimPages([page("/guide/install/", PAGE)], budget);
  const trimmed = result.pages[0]!;

  assert.deepEqual(
    trimmed.keptSections.map((section) => section.text),
    ["Requirements"],
  );
  assert.deepEqual(
    trimmed.droppedSections.map((section) => section.text),
    ["Steps", "Troubleshooting"],
  );
  assert.equal(trimmed.markdown, LEAD_AND_FIRST);
  assert.ok(trimmed.tokens <= budget, `${trimmed.tokens} tokens against a budget of ${budget}`);
});

test("a page keeps its title heading and first paragraph even when nothing else fits", async () => {
  const result = await trimPages([page("/guide/code/", PAGE)], 10);
  const trimmed = result.pages[0]!;

  assert.ok(trimmed.markdown.startsWith("# Install the engine\n\nInstall the engine before you configure the site."));
  assert.equal(trimmed.markdown, LEAD_AND_FIRST.split("\n\n## Requirements")[0]);
  assert.deepEqual(trimmed.keptSections, []);
  assert.ok(trimmed.tokens > 10, "the mandatory content is kept even though it exceeds the budget");

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "pack.trim.over-budget");
  assert.equal(result.diagnostics[0]?.severity, "warning");
});

test("the first section is mandatory when the page begins with a heading and has no lead paragraph", async () => {
  const markdown = `## First

First paragraph.

## Second

Second paragraph.`;
  const result = await trimPages([page("/guide/first/", markdown)], 3);
  const trimmed = result.pages[0]!;

  assert.equal(trimmed.markdown, "## First\n\nFirst paragraph.");
  assert.deepEqual(
    trimmed.keptSections.map((section) => section.text),
    ["First"],
  );
  assert.deepEqual(
    trimmed.droppedSections.map((section) => section.text),
    ["Second"],
  );
  assert.ok(trimmed.tokens > 3);
  assert.equal(result.diagnostics.length, 1);
});

test("code is atomic: a dropped fence is dropped whole, and a heading inside a fence is not a section", async () => {
  const markdown = `# Code

Intro paragraph.

## Example

\`\`\`md
## Not a heading
const answer = 42;
\`\`\`

## Trailing

Last section.`;

  const fits = await trimPages([page("/guide/code/", markdown)], 10_000);
  assert.deepEqual(
    fits.pages[0]?.keptSections.map((section) => section.text),
    ["Example", "Trailing"],
    "the heading inside the fence stays inside its section",
  );
  assert.equal(fits.pages[0]?.markdown, markdown);

  const budget = estimateTokens("# Code\n\nIntro paragraph.").tokens;
  const trimmed = (await trimPages([page("/guide/code/", markdown)], budget)).pages[0]!;
  assert.equal(trimmed.markdown, "# Code\n\nIntro paragraph.");
  assert.ok(!trimmed.markdown.includes("\u0060\u0060\u0060"), "no fence is left open or cut in half");
  assert.deepEqual(
    trimmed.droppedSections.map((section) => section.text),
    ["Example", "Trailing"],
  );
});

test("Persian pages trim by the same rules", async () => {
  const markdown = `# نصب موتور

موتور را پیش از پیکربندی نصب کنید.

## نیازمندی‌ها

به Node 24 یا جدیدتر نیاز دارید.

## گام‌ها

نصب‌کننده را اجرا کنید.`;
  const leadAndFirst = `# نصب موتور

موتور را پیش از پیکربندی نصب کنید.

## نیازمندی‌ها

به Node 24 یا جدیدتر نیاز دارید.`;
  const budget = estimateTokens(leadAndFirst).tokens;
  const result = await trimPages([page("/fa/install/", markdown, "guide/fa/install.md")], budget);
  const trimmed = result.pages[0]!;

  assert.equal(trimmed.markdown, leadAndFirst);
  assert.ok(trimmed.markdown.includes("نصب موتور"));
  assert.deepEqual(
    trimmed.keptSections.map((section) => section.text),
    ["نیازمندی‌ها"],
  );
  assert.deepEqual(
    trimmed.droppedSections.map((section) => section.text),
    ["گام‌ها"],
  );
  assert.ok(trimmed.tokens <= budget);
});

test("the same input gives the same output in the input order, without mutating the pages", async () => {
  const pages = [page("/guide/a/", PAGE, "guide/a.md"), page("/guide/b/", PAGE, "guide/b.md")];
  const before = pages.map((entry) => entry.markdown);
  const budget = estimateTokens(LEAD_AND_FIRST).tokens + 20;

  const first = await trimPages(pages, budget);
  const second = await trimPages(pages, budget);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.pages.map((entry) => entry.url),
    ["/guide/a/", "/guide/b/"],
    "pages stay in the caller's ranking order",
  );
  assert.ok(first.pages.every((entry) => entry.tokens <= budget));
  assert.deepEqual(
    pages.map((entry) => entry.markdown),
    before,
    "the input pages are not mutated",
  );
});

test("a page with no section heading, or with one, is all lead and is never trimmed", async () => {
  const noHeading = "Just a paragraph.\n\nAnd another paragraph.";
  const oneHeading = "# Only\n\nOne paragraph.\n\nSecond paragraph.";

  for (const markdown of [noHeading, oneHeading]) {
    const result = await trimPages([page("/guide/lead/", markdown)], 1);
    assert.equal(result.pages[0]?.markdown, markdown, markdown);
    assert.deepEqual(result.pages[0]?.keptSections, []);
    assert.deepEqual(result.pages[0]?.droppedSections, []);
    assert.equal(result.diagnostics.length, 1, "the whole page is mandatory");
  }
});

test("positions start at the page's source line, after front matter", async () => {
  const result = await trimPages([page("/guide/offset/", "# Title\n\nIntro.", "guide/offset.md", 5)], 1);
  const diagnostic = result.diagnostics[0];

  assert.ok(diagnostic !== undefined);
  assert.deepEqual(diagnostic.pos, {
    file: "guide/offset.md",
    line: 5,
    column: 1,
    endLine: 5,
    endColumn: "# Title".length,
  });
});

test("the estimator can be replaced, and tokens follow it", async () => {
  const width = (text: string): number => text.length;
  const count = (text: string): number => [...text].length;

  const fits = await trimPages([page("/guide/install/", PAGE)], 10_000, { estimate: width });
  assert.equal(fits.pages[0]?.tokens, PAGE.length);

  const trimmed = await trimPages([page("/guide/install/", PAGE)], 10_000, { estimate: count });
  assert.equal(trimmed.pages[0]?.tokens, [...PAGE].length);
});

test("keep pins a section by heading text or by block id", async () => {
  const markdown = `# Keep

Intro paragraph.

## A

A text.

## B

B text.

## C

C text.`;
  const lead = `# Keep

Intro paragraph.`;
  const budget = estimateTokens(`${lead}

## A

A text.

## C

C text.`).tokens;
  const ids = (await trimPages([page("/guide/keep/", markdown)], 10_000)).pages[0]!;
  const sectionC = ids.keptSections.find((section) => section.text === "C");
  assert.ok(sectionC !== undefined);

  for (const keep of [["C"], [sectionC.id]]) {
    const result = await trimPages([page("/guide/keep/", markdown)], budget, { keep });
    const trimmed = result.pages[0]!;
    assert.deepEqual(
      trimmed.keptSections.map((section) => section.text),
      ["A", "C"],
      JSON.stringify(keep),
    );
    assert.deepEqual(
      trimmed.droppedSections.map((section) => section.text),
      ["B"],
      JSON.stringify(keep),
    );
    assert.equal(trimmed.markdown, `${lead}

## A

A text.

## C

C text.`);
  }
});

test("an over-budget result carries a diagnostic at the page's source position", async () => {
  const result = await trimPages([page("/guide/install/", PAGE, "guide/install.md")], 10);
  const diagnostic = result.diagnostics[0];

  assert.ok(diagnostic !== undefined);
  assert.deepEqual(diagnostic.pos, {
    file: "guide/install.md",
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: "# Install the engine".length,
  });
  assert.match(diagnostic.message, /budget/);
});

test("when each page fits alone but they do not fit together, one diagnostic points at the first page", async () => {
  const one = `# One

First paragraph of one.

## A

A text.`;
  const two = `# Two

First paragraph of two.

## B

B text.`;
  const leadOf = (markdown: string): string => markdown.split("\n\n## ")[0]!;
  const budget = Math.max(estimateTokens(leadOf(one)).tokens, estimateTokens(leadOf(two)).tokens) + 1;
  const pages = [page("/guide/one/", one, "guide/one.md"), page("/guide/two/", two, "guide/two.md")];

  assert.ok(estimateTokens(one).tokens + estimateTokens(two).tokens > budget);
  const result = await trimPages(pages, budget);

  assert.ok(result.pages.every((entry) => entry.droppedSections.length === 1));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "pack.trim.over-budget");
  assert.deepEqual(result.diagnostics[0]?.pos, pos("guide/one.md"));
});
