import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "../src/contracts/index.ts";
import { TrimEstimateError, trimPages } from "../src/packs/trim.ts";

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

/** Both enforcement modes; the boundary it guards is the same in either. */
const MODES = ["estimate", "hard"] as const;

const PAGE = `# Install the engine

Install the engine before you configure the site.

## Requirements

You need Node 24 or newer and a terminal.

## Steps

Run the installer and follow the prompts.
`;

/** Every value that is not a token count, with the name the error message must carry. */
const INVALID = [
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["a negative estimate", -1],
] as const;

/** Counts characters, but returns `NaN` for any text carrying the marker. */
function refuseBroken(text: string): number {
  return text.includes("BROKEN") ? Number.NaN : text.length;
}

test("NaN, infinities, and negative estimates are refused in both modes", async () => {
  for (const mode of MODES) {
    for (const [label, value] of INVALID) {
      await assert.rejects(
        trimPages([page("/guide/install/", PAGE)], 10_000, { mode, estimate: () => value }),
        (error: unknown) => {
          assert.ok(error instanceof TrimEstimateError, `${mode}: ${label} is refused with TrimEstimateError`);
          assert.equal(error.name, "TrimEstimateError");
          assert.equal(error.value, value, `${mode}: ${label} is reported as returned`);
          assert.ok(error.message.includes(String(value)), `${mode}: ${label} is named in the message`);
          return true;
        },
      );
    }
  }
});

test("mandatory content is measured at the same boundary", async () => {
  const markdown = `# Install the engine

BROKEN intro paragraph.

## Steps

Run the installer.`;

  for (const mode of MODES) {
    await assert.rejects(
      trimPages([page("/guide/install/", markdown)], 10_000, { mode, estimate: refuseBroken }),
      TrimEstimateError,
      `${mode}: the mandatory lead is refused instead of counted as free`,
    );
  }
});

test("optional sections are measured at the same boundary", async () => {
  const markdown = `# Install the engine

Intro paragraph.

## Requirements

You need Node 24 or newer.

## Steps

BROKEN section body.`;

  for (const mode of MODES) {
    await assert.rejects(
      trimPages([page("/guide/install/", markdown)], 10_000, { mode, estimate: refuseBroken }),
      TrimEstimateError,
      `${mode}: an optional section is refused instead of counted as free`,
    );
  }
});

test("required evidence is measured at the same boundary", async () => {
  const required = [{ id: "source", kind: "source", text: "BROKEN evidence" }];

  for (const mode of MODES) {
    await assert.rejects(
      trimPages([], 10_000, { mode, estimate: refuseBroken, required }),
      TrimEstimateError,
      `${mode}: required evidence is refused instead of counted as free`,
    );
  }
});

test("zero is valid, and positive fractional estimates keep rounding up", async () => {
  for (const mode of MODES) {
    const zero = await trimPages([page("/guide/install/", PAGE)], 0, { mode, estimate: () => 0 });
    assert.equal(zero.status, "fits", `${mode}: a zero estimate can fit a zero budget`);
    assert.equal(zero.accounting.tokens, 0);
    assert.equal(zero.pages[0]?.tokens, 0);
    assert.equal(zero.pages[0]?.keptSections.length, 2);
    assert.deepEqual(zero.omissions, []);

    const fractional = await trimPages([page("/guide/install/", PAGE)], 3, { mode, estimate: () => 2.2 });
    assert.equal(fractional.status, "fits", `${mode}: 2.2 tokens round up to 3, which fits a budget of 3`);
    assert.equal(fractional.accounting.tokens, 3);
    assert.equal(fractional.accounting.method, "custom");
    assert.equal(fractional.accounting.margin, 0);
    assert.equal(fractional.accounting.upper, 3);
    assert.equal(fractional.pages[0]?.tokens, 3);
  }
});
