/**
 * Issue #111 (M5.11): hard trimming offers the budget that removing a near-duplicate freed back to the unique
 * sections the budget had omitted, instead of returning a pack smaller than its budget allows.
 *
 * The `width` estimator makes the arithmetic exact: hard mode gives a custom estimator no margin, so one character
 * is one token and a test can state a budget as the length of the serialization it expects.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "../src/contracts/index.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN } from "../src/packs/tokens.ts";
import { trimPages, type RequiredEvidence } from "../src/packs/trim.ts";

const SOURCE = "guide/rollout.md";

function page(url: string, markdown: string, source = SOURCE, line = 1): Page {
  return {
    url,
    source: { file: source, line, column: 1, endLine: line, endColumn: 1 },
    frontMatter: {},
    title: "Rollout",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The estimator's planning upper bound for a text: the measure hard mode enforces. */
function upperOf(text: string): number {
  return Math.ceil(estimateTokens(text).tokens * (1 + TOKEN_ERROR_MARGIN));
}

/** The canonical serialization: the non-empty parts joined with one blank line. */
function serialize(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

/** Hard mode prices a custom estimator with no margin, so here a character is a token. */
const width = (text: string): number => text.length;

/** A page's Markdown: a lead and the given sections, in document order. */
function doc(lead: string, sections: readonly string[]): string {
  return serialize([lead, ...sections]);
}

/** A page's Markdown with only the sections at the given indexes kept: an expected serialization. */
function kept(lead: string, sections: readonly string[], indexes: readonly number[]): string {
  return serialize([lead, ...indexes.map((index) => sections[index]!)]);
}

/**
 * A `## heading` section whose Markdown is exactly `target` characters, with a body of one or two words so that
 * only an exact repeat counts as its duplicate: the distinct words stay under the near-duplicate threshold.
 */
function exactSection(heading: string, target: number): string {
  const prefix = `## ${heading}\n\n`;
  const word = heading.toLowerCase().replace(/[^a-z0-9]/g, "");
  const room = target - prefix.length;
  assert.ok(room >= 1, `${heading} needs room for a body at ${target} characters`);
  const body = room > word.length + 1 ? `${word} ${"x".repeat(room - word.length - 1)}` : word.slice(0, room);
  const markdown = `${prefix}${body}`;
  assert.equal(markdown.length, target, "the fixture length the test prices");
  return markdown;
}

const ZERO_LEAD = "# Zero\n\nLead paragraph of the zeroth page.";
const ONE_LEAD = "# One\n\nLead paragraph of the first page.";
const TWO_LEAD = "# Two\n\nLead paragraph of the second page.";

/** A repeated section: only its first copy, in page and document order, may stay in the pack. */
const DEPLOY = exactSection("Rolling deploy", 60);

const EVIDENCE: readonly RequiredEvidence[] = [
  { id: "source", kind: "source", text: "- Source: guide/rollout.md" },
  { id: "version", kind: "version", text: "- Version: 0.1.0" },
];

// Prose fixtures, for the tests that price the default estimator and its margin.
const PROSE_DEPLOY = `## Rolling deploy

Build the release bundle, copy the bundle directory to the target host over the private network, restart the
service unit, flush the edge cache, open the home page, follow the first three navigation links, confirm that
every page renders without an error, and record the version the footer reports.`;

const PROSE_CANARY = `## Canary window

Watch the canary error rate, the request latency, and the queue depth through the whole observation window, then
promote the release, drain the previous host one request at a time, keep the rollback archive within reach of the
target host, and note the outcome of every step in the deploy log so the audit trail records the version.`;

const ROLLBACK = `## Alpha rollback

Roll the previous release archive back to the host and restart the service unit.`;

const WATCHLOG = `## Beta watch

Watch the service log through the next deploy window on the host.`;

const ONE_DOC = doc(`# Rollout one\n\nFirst paragraph of the rollout guide.`, [PROSE_DEPLOY, ROLLBACK]);
const TWO_DOC = doc(`# Rollout two\n\nFirst paragraph of the second rollout page.`, [PROSE_DEPLOY, WATCHLOG]);
const LEAD_ONE = "# Rollout one\n\nFirst paragraph of the rollout guide.";
const LEAD_TWO = "# Rollout two\n\nFirst paragraph of the second rollout page.";

test("#111 spends the budget a duplicate freed on the unique sections the budget omitted", async () => {
  const pages = [
    page("/guide/rollout-one/", ONE_DOC, "guide/rollout-one.md"),
    page("/guide/rollout-two/", TWO_DOC, "guide/rollout-two.md"),
  ];
  // The budget is exactly the pack that keeps both copies of the repeated section, so the first allocation pass
  // spends it on the duplicate and leaves both unique sections out for budget.
  const crowded = serialize([kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0]), kept(LEAD_TWO, [PROSE_DEPLOY, WATCHLOG], [0])]);
  const restored = serialize([
    kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0, 1]),
    kept(LEAD_TWO, [PROSE_DEPLOY, WATCHLOG], [1]),
  ]);
  assert.ok(
    estimateTokens(ROLLBACK).tokens + estimateTokens(WATCHLOG).tokens < estimateTokens(PROSE_DEPLOY).tokens,
    "the freed budget is worth more than both unique sections",
  );

  const result = await trimPages(pages, upperOf(crowded), { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, restored, "the freed space goes to the unique sections, not back to the caller");
  assert.equal(result.markdown.split("## Rolling deploy").length, 2, "the repeated section is kept exactly once");
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["Rolling deploy", "Alpha rollback"], ["Beta watch"]],
  );

  const canonical = result.pages[0]!.keptSections.find((section) => section.text === "Rolling deploy")!;
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason, omission.duplicateOf?.url, omission.duplicateOf?.id]),
    [["/guide/rollout-two/", "Rolling deploy", "duplicate", "/guide/rollout-one/", canonical.id]],
    "the duplicate stays omitted and keeps its link to the canonical section",
  );
  assert.deepEqual(result.diagnostics, []);
});

test("#111 calls a budget omission a duplicate once a kept section carries the same text", async () => {
  const pages = [
    page("/guide/rollout-one/", ONE_DOC, "guide/rollout-one.md"),
    page("/guide/rollout-two/", TWO_DOC, "guide/rollout-two.md"),
  ];
  // The second page's copy never earns a turn in the first pass, and its unique section is the one that does not
  // fit the space the surviving duplicate frees.
  const target = serialize([kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0, 1]), LEAD_TWO]);

  const result = await trimPages(pages, upperOf(target), { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, target);
  assert.deepEqual(
    result.pages[1]!.droppedSections.map((section) => section.text),
    ["Rolling deploy", "Beta watch"],
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.text, omission.reason, omission.duplicateOf === undefined]),
    [
      ["Rolling deploy", "duplicate", false],
      ["Beta watch", "budget", true],
    ],
    "raising the budget would not help the repeated section, so its reason says it is a duplicate",
  );
});

test("#111 prices a restored section against the whole serialization, not against its own estimate", async () => {
  const candidate = exactSection("Beta only", DEPLOY.length + 1);
  const pages = [
    page("/guide/zero/", doc(ZERO_LEAD, [DEPLOY]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY, candidate]), "guide/one.md"),
  ];
  const crowded = serialize([kept(ZERO_LEAD, [DEPLOY], [0]), kept(ONE_LEAD, [DEPLOY, candidate], [0])]);
  // After deduplication the first copy of the repeated section survives in canonical form, so the pack the rejected
  // candidate leaves behind still keeps it; only its own duplicate is spent to make room for the candidate.
  const freed = serialize([kept(ZERO_LEAD, [DEPLOY], [0]), ONE_LEAD]);
  // The duplicate frees DEPLOY.length + 2 characters of the serialization, one fewer than the candidate costs:
  // its own estimate still fits the leftover budget, so only the complete serialization rejects it.
  assert.equal(crowded.length - freed.length, DEPLOY.length + 2);
  assert.ok(candidate.length < crowded.length - freed.length + 2);

  const result = await trimPages(pages, crowded.length, { mode: "hard", estimate: width });

  assert.equal(result.status, "fits");
  assert.equal(result.accounting.upper, result.accounting.tokens);
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, freed, "the section that does not fit the serialization stays out");
  assert.deepEqual(
    result.omissions.map((omission) => [omission.text, omission.reason]),
    [["Rolling deploy", "duplicate"], ["Beta only", "budget"]],
  );
  assert.equal(result.accounting.remaining, DEPLOY.length + 2);
});

test("#111 holds a restored section to the estimator's upper bound, not to its estimate", async () => {
  const pages = [
    page("/guide/zero/", doc(LEAD_ONE, [PROSE_DEPLOY]), "guide/rollout-one.md"),
    page("/guide/one/", doc(LEAD_TWO, [PROSE_DEPLOY, PROSE_CANARY]), "guide/rollout-two.md"),
  ];
  const crowded = serialize([kept(LEAD_ONE, [PROSE_DEPLOY], [0]), kept(LEAD_TWO, [PROSE_DEPLOY, PROSE_CANARY], [0])]);
  const freed = serialize([kept(LEAD_ONE, [PROSE_DEPLOY], [0]), LEAD_TWO]);
  const admitted = serialize([kept(LEAD_ONE, [PROSE_DEPLOY], [0]), kept(LEAD_TWO, [PROSE_DEPLOY, PROSE_CANARY], [1])]);
  // The candidate is worth less than the headroom the estimate leaves after the margin, but adding it grows the
  // whole serialization's upper bound past the limit.
  assert.ok(
    estimateTokens(PROSE_CANARY).tokens <= upperOf(crowded) - upperOf(freed),
    "a check on the estimate alone would readmit it",
  );
  assert.ok(upperOf(admitted) > upperOf(crowded), "the upper bound of the complete serialization does not fit");

  const result = await trimPages(pages, upperOf(crowded), { mode: "hard" });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, freed);
  assert.deepEqual(
    result.omissions.map((omission) => [omission.text, omission.reason]),
    [["Rolling deploy", "duplicate"], ["Canary window", "budget"]],
  );
});

test("#111 gives every page one turn per round when it spends the freed budget", async () => {
  const first = exactSection("Alpha only", 26);
  const second = exactSection("Beta only", 26);
  const third = exactSection("Gamma only", 26);
  const pages = [
    page("/guide/zero/", doc(ZERO_LEAD, [DEPLOY]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY, first, second]), "guide/one.md"),
    page("/guide/two/", doc(TWO_LEAD, [third]), "guide/two.md"),
  ];
  const crowded = serialize([kept(ZERO_LEAD, [DEPLOY], [0]), kept(ONE_LEAD, [DEPLOY, first, second], [0]), TWO_LEAD]);
  // The freed space covers two short sections. Equal turns give one to the second page and one to the third;
  // filling page by page would hand both to the higher-ranked page and starve the last one.
  const expected = serialize([
    kept(ZERO_LEAD, [DEPLOY], [0]),
    kept(ONE_LEAD, [DEPLOY, first, second], [1]),
    kept(TWO_LEAD, [third], [0]),
  ]);

  const result = await trimPages(pages, crowded.length, { mode: "hard", estimate: width });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, expected);
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["Rolling deploy"], ["Alpha only"], ["Gamma only"]],
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason]),
    [["/guide/one/", "Rolling deploy", "duplicate"], ["/guide/one/", "Beta only", "budget"]],
  );
});

test("#111 never re-admits a section another page restored in the same round", async () => {
  // Two lower-ranked pages hold byte-identical candidates. The duplicate's freed space is enough for both, so an
  // offer that ignored what a higher-ranked page had just admitted would keep the candidate twice over and defeat
  // deduplication; the pass must offer the surviving one's content only once (#111).
  const candidate = exactSection("Same note", 32);
  const pages = [
    page("/guide/zero/", doc(ZERO_LEAD, [DEPLOY]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY, candidate]), "guide/one.md"),
    page("/guide/two/", doc(TWO_LEAD, [DEPLOY, candidate]), "guide/two.md"),
  ];
  const crowded = serialize([
    kept(ZERO_LEAD, [DEPLOY], [0]),
    kept(ONE_LEAD, [DEPLOY, candidate], [0]),
    kept(TWO_LEAD, [DEPLOY, candidate], [0]),
  ]);

  const result = await trimPages(pages, crowded.length, { mode: "hard", estimate: width });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown.split("## Same note").length, 2, "the byte-identical candidate is kept exactly once");
  assert.equal(
    result.markdown,
    serialize([kept(ZERO_LEAD, [DEPLOY], [0]), kept(ONE_LEAD, [DEPLOY, candidate], [1]), TWO_LEAD]),
    "the higher-ranked page wins the shared candidate and the pack still keeps the canonical duplicate once",
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason]),
    [
      ["/guide/one/", "Rolling deploy", "duplicate"],
      ["/guide/two/", "Rolling deploy", "duplicate"],
      ["/guide/two/", "Same note", "duplicate"],
    ],
    "the restored candidate's own duplicate is reported as a duplicate, not a budget omission",
  );

  const keptIds = new Set(result.pages.flatMap((entry) => entry.keptSections.map((section) => section.id)));
  for (const omission of result.omissions) {
    assert.ok(omission.duplicateOf !== undefined, `${omission.text} names a canonical section`);
    assert.ok(keptIds.has(omission.duplicateOf.id), `${omission.text} names a section the pack keeps`);
  }
  assert.deepEqual(result.diagnostics, []);
});

test("#111 keeps required evidence, mandatory content, and pinned sections while reallocating", async () => {
  const pinned = exactSection("Beta watch", 26);
  const unique = exactSection("Alpha only", 26);
  const note = exactSection("Zero note", 26);
  const pages = [
    page("/guide/zero/", doc("", [DEPLOY, note]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY, pinned, unique]), "guide/one.md"),
  ];
  const crowded = serialize([
    ...EVIDENCE.map((item) => item.text),
    kept("", [DEPLOY, note], [0, 1]),
    kept(ONE_LEAD, [DEPLOY, pinned, unique], [0, 1]),
  ]);

  const result = await trimPages(pages, crowded.length, {
    mode: "hard",
    estimate: width,
    required: EVIDENCE,
    keep: ["Beta watch"],
  });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  for (const item of EVIDENCE) assert.ok(result.markdown.includes(item.text), `${item.id} survives the reallocation`);
  assert.ok(result.markdown.startsWith(EVIDENCE[0]!.text), "the required evidence still comes first");
  assert.ok(result.accounting.required <= result.accounting.tokens);
  assert.deepEqual(result.required.map((item) => item.id), ["source", "version"]);
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["Rolling deploy", "Zero note"], ["Beta watch", "Alpha only"]],
    "the mandatory section, the pinned section, and the freed budget's unique section all survive",
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason, omission.duplicateOf?.url]),
    [["/guide/one/", "Rolling deploy", "duplicate", "/guide/zero/"]],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("#111 restores in document order inside a page whose duplicate gave way", async () => {
  const first = exactSection("Alpha only", 26);
  const second = exactSection("Beta only", 26);
  const pages = [
    page("/guide/zero/", doc(ZERO_LEAD, [DEPLOY]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY, first, second]), "guide/one.md"),
  ];
  const crowded = serialize([kept(ZERO_LEAD, [DEPLOY], [0]), kept(ONE_LEAD, [DEPLOY, first, second], [0])]);

  const result = await trimPages(pages, crowded.length, { mode: "hard", estimate: width });

  assert.equal(result.status, "fits");
  assert.ok(result.accounting.upper <= result.accounting.limit, `${result.accounting.upper} against a limit of ${result.accounting.limit}`);
  assert.equal(result.markdown, serialize([kept(ZERO_LEAD, [DEPLOY], [0]), kept(ONE_LEAD, [DEPLOY, first, second], [1, 2])]),
    "both candidates fit the freed space, and they appear in document order");
  assert.deepEqual(
    result.pages[1]!.keptSections.map((section) => section.text),
    ["Alpha only", "Beta only"],
  );
});

test("#111 terminates, stays deterministic, and links every duplicate to a kept section", async () => {
  const shared = [exactSection("Rolling deploy", 60), exactSection("Cache flush", 40)];
  const words = ["note", "detail", "caveat", "remark", "addendum", "gloss"];
  const built = words.map((word, index) => {
    const lead = `# Page ${index}\n\nLead paragraph number ${index}.`;
    return {
      lead,
      sections: [...shared, exactSection(`${word} one`, 32), exactSection(`${word} two`, 32)],
    };
  });
  const pages = built.map((entry, index) => page(`/guide/many/${index}/`, doc(entry.lead, entry.sections), `guide/many/${index}.md`));
  const mandatory = serialize([...EVIDENCE.map((item) => item.text), ...built.map((entry) => entry.lead)]);
  assert.ok(mandatory.length + 200 < 10_000);

  const first = await trimPages(pages, mandatory.length + 200, { mode: "hard", estimate: width, required: EVIDENCE });
  const again = await trimPages(pages, mandatory.length + 200, { mode: "hard", estimate: width, required: EVIDENCE });

  assert.deepEqual(again, first, "the same input gives byte-identical output");
  assert.equal(first.status, "fits");
  assert.ok(first.accounting.upper <= first.accounting.limit, `${first.accounting.upper} against a limit of ${first.accounting.limit}`);
  assert.ok(first.omissions.some((omission) => omission.reason === "duplicate"), "the repeated sections are omitted");
  assert.ok(
    first.omissions.some((omission) => omission.reason === "budget"),
    "a unique section the remaining budget cannot take stays a budget omission",
  );

  const keptIds = new Set(first.pages.flatMap((entry) => entry.keptSections.map((section) => section.id)));
  for (const omission of first.omissions) {
    if (omission.reason === "duplicate") {
      assert.ok(omission.duplicateOf !== undefined, `${omission.text} names a canonical section`);
      assert.ok(keptIds.has(omission.duplicateOf.id), `${omission.text} names a section the pack keeps`);
    } else {
      assert.equal(omission.duplicateOf, undefined, `${omission.text} says the budget left it out`);
    }
  }

  assert.equal(first.markdown.split("## Rolling deploy").length, 2, "a repeated section survives once");
  assert.ok(first.markdown.split("## Cache flush").length <= 2, "so does the second repeated section");
  for (const entry of built) {
    assert.ok(first.markdown.includes(entry.lead), "every page keeps its mandatory heading and first paragraph");
  }
  assert.ok(first.accounting.remaining < 34, `${first.accounting.remaining} of the freed budget went unused`);
  assert.equal(first.accounting.budget, mandatory.length + 200);
  assert.deepEqual(first.diagnostics, []);
});

test("#111 leaves the default estimate mode's bytes, accounting, and omissions untouched", async () => {
  const pages = [
    page("/guide/rollout-one/", ONE_DOC, "guide/rollout-one.md"),
    page("/guide/rollout-two/", TWO_DOC, "guide/rollout-two.md"),
  ];
  // The estimate mode trims from the last page backwards and then deduplicates: the space a duplicate frees is
  // never spent, so the pack stays smaller than its budget.
  const trimmed = serialize([kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0, 1]), kept(LEAD_TWO, [PROSE_DEPLOY, WATCHLOG], [0])]);
  const expected = serialize([kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0, 1]), LEAD_TWO]);

  const result = await trimPages(pages, estimateTokens(trimmed).tokens);

  assert.equal(result.markdown, expected);
  assert.equal(result.pages[0]?.markdown, kept(LEAD_ONE, [PROSE_DEPLOY, ROLLBACK], [0, 1]));
  assert.equal(result.accounting.tokens, estimateTokens(expected).tokens);
  assert.equal(result.accounting.upper, upperOf(expected));
  assert.equal(result.status, "fits");
  assert.deepEqual(
    result.pages.map((entry) => entry.keptSections.map((section) => section.text)),
    [["Rolling deploy", "Alpha rollback"], []],
    "the unique section that would fit the freed budget stays omitted in estimate mode",
  );
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason]),
    [
      ["/guide/rollout-two/", "Rolling deploy", "duplicate"],
      ["/guide/rollout-two/", "Beta watch", "budget"],
    ],
  );
});

test("#111 does not readmit a duplicate when the budget leaves room for it", async () => {
  const pages = [
    page("/guide/zero/", doc(ZERO_LEAD, [DEPLOY]), "guide/zero.md"),
    page("/guide/one/", doc(ONE_LEAD, [DEPLOY]), "guide/one.md"),
  ];

  const result = await trimPages(pages, 10_000, { mode: "hard", estimate: width });

  assert.equal(result.status, "fits");
  assert.equal(result.markdown, serialize([doc(ZERO_LEAD, [DEPLOY]), ONE_LEAD]), "the freed space stays unused when nothing unique is left");
  assert.deepEqual(result.pages[1]!.keptSections, []);
  assert.ok(result.accounting.remaining > 0);
  assert.deepEqual(
    result.omissions.map((omission) => [omission.url, omission.text, omission.reason, omission.duplicateOf?.url]),
    [["/guide/one/", "Rolling deploy", "duplicate", "/guide/zero/"]],
  );
});
