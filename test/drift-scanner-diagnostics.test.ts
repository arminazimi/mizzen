import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { compareClaims, comparePages } from "../src/drift/compare.ts";
import { codeRefsOf } from "../src/drift/code-refs.ts";

/**
 * Issue #103: a cited TypeScript file the scanner cannot read must surface its own
 * `drift.symbols-syntax` finding, with the real position inside the target, instead of being
 * misreported as a file that simply exports nothing.
 */

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "drift-scanner-diagnostics-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A Markdown page whose body starts at `line` in its source file. */
function page(file: string, markdown: string, line = 1): Page {
  return {
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { file, line, column: 1, endLine: line, endColumn: 1 },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The diagnostics of one run over `pages`. */
async function compare(root: string, pages: readonly Page[]): Promise<Diagnostic[]> {
  return compareClaims(pages, { root });
}

/** SHA-256 of the exact bytes, as 64 lowercase hex characters. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A TypeScript file whose last comment never closes, so the scanner fails at line 4, column 1. */
const BROKEN = ["export function buildDocs() {", "  return 1;", "}", "/* never closed"].join("\n");

/** The scanner finding's real position inside the cited target. */
const TARGET_POS = { file: "src/broken.ts", line: 4, column: 1, endLine: 4, endColumn: 1 };

/** A well-formed TypeScript file with `buildDocs` on line 2 and `loadConfig` on line 6. */
function scanned(): string {
  return [
    "// helpers", // 1
    "export function buildDocs() {", // 2
    "  return 1;", // 3
    "}", // 4
    "", // 5
    "export function loadConfig() {", // 6
    "  return 2;", // 7
    "}", // 8
  ].join("\n");
}

test("a malformed cited source reports drift.symbols-syntax at its real target position", async () => {
  const root = site();
  try {
    write(root, "src/broken.ts", BROKEN);
    const model = page("setup.md", "Call `buildDocs()` at src/broken.ts:1.");
    const [ref] = await codeRefsOf(model);

    const diagnostics = await compare(root, [model]);
    assert.equal(diagnostics.length, 1);
    const [diagnostic] = diagnostics as [Diagnostic, ...Diagnostic[]];
    assert.equal(diagnostic.id, "drift.symbols-syntax");
    assert.equal(diagnostic.severity, "error");
    assert.deepEqual(diagnostic.pos, TARGET_POS);
    assert.match(diagnostic.message, /src\/broken\.ts/);

    const [comparison] = await comparePages([model], { root });
    assert.deepEqual(comparison?.diagnostics.map((each) => each.id), ["drift.symbols-syntax"]);
    assert.equal(comparison?.findings.length, 1);
    // The finding stays associated with the citing reference, and no position is invented for it.
    assert.deepEqual(comparison?.findings[0]?.reference, ref);
    assert.deepEqual(comparison?.diagnostics[0]?.pos, TARGET_POS);
    assert.notDeepEqual(comparison?.diagnostics[0]?.pos, ref?.pos);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scanner failure is never downgraded to clean or to an exportless file", async () => {
  const root = site();
  try {
    write(root, "src/broken.ts", BROKEN);
    const pages = [
      // A bare line citation: the old behaviour reported a file that exports nothing.
      page("bare.md", "See src/broken.ts:1."),
      // A claimed symbol: the old behaviour reported a missing symbol.
      page("claim.md", "Call `buildDocs()` at src/broken.ts:1."),
      // A claim that only looks like a symbol, over a cited line range.
      page("range.md", "The `Widget` lives at src/broken.ts:1-3."),
    ];
    const diagnostics = await compare(root, pages);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), [
      "drift.symbols-syntax",
      "drift.symbols-syntax",
      "drift.symbols-syntax",
    ]);
    assert.ok(!diagnostics.some((diagnostic) => diagnostic.id === "drift.missing-symbol"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several citations of one malformed target keep every finding in a stable order", async () => {
  const root = site();
  try {
    write(root, "src/broken.ts", BROKEN);
    const markdown = [
      "First see src/broken.ts:1.", // 1
      "", // 2
      "Then `buildDocs()` at src/broken.ts:4.", // 3
      "", // 4
      "Two paths in one span: `src/broken.ts:2 and src/broken.ts:3`.", // 5
    ].join("\n");
    const model = page("setup.md", markdown);
    const other = page("other.md", "Again src/broken.ts:1.");

    const first = await comparePages([model, other], { root });
    const again = await comparePages([model, other], { root });
    assert.deepEqual(again, first);

    const comparison = first[0]!;
    assert.equal(comparison.findings.length, 4);
    assert.deepEqual(comparison.diagnostics.map((diagnostic) => diagnostic.id), [
      "drift.symbols-syntax",
      "drift.symbols-syntax",
      "drift.symbols-syntax",
      "drift.symbols-syntax",
    ]);
    // Every citation keeps its own finding, ordered by the citation's place in the page.
    assert.deepEqual(
      comparison.findings.map((finding) => [finding.reference.line, finding.reference.pos.line]),
      [
        [1, 1],
        [4, 3],
        [2, 5],
        [3, 5],
      ],
    );
    // The reported position is the real one inside the target, never the page's.
    for (const finding of comparison.findings) {
      assert.deepEqual(finding.diagnostic.pos, TARGET_POS);
      assert.equal(finding.diagnostic.id, "drift.symbols-syntax");
    }
    // A second page citing the same target gets the finding too.
    assert.deepEqual(first[1]?.findings.map((finding) => [finding.reference.path, finding.reference.line]), [
      ["src/broken.ts", 1],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scanner finding orders predictably against other findings on the same page", async () => {
  const root = site();
  try {
    write(root, "src/broken.ts", BROKEN);
    const model = page("setup.md", "See src/gone.ts:1.\n\nUse `buildDocs()` at src/broken.ts:1.");

    const diagnostics = await compare(root, [model]);
    assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.pos?.line, diagnostic.id]), [
      [1, "drift.missing-file"],
      [4, "drift.symbols-syntax"],
    ]);

    const [comparison] = await comparePages([model], { root });
    assert.deepEqual(comparison?.findings.map((finding) => finding.reference.path), [
      "src/gone.ts",
      "src/broken.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source identity covers exactly the bytes that failed to scan", async () => {
  const root = site();
  try {
    write(root, "src/broken.ts", BROKEN);
    write(root, "src/notes.txt", "plain text\n");
    const model = page("setup.md", "See src/broken.ts:1 and src/notes.txt:1.");

    const [comparison] = await comparePages([model], { root });
    assert.equal(comparison?.identity.sources["src/broken.ts"], digest(BROKEN));
    assert.equal(comparison?.identity.sources["src/notes.txt"], digest("plain text\n"));

    // A different failure in the same file changes both the evidence and the reported position.
    const Worse = ["export function buildDocs() {", "  return 1;", "}", "", "export const = 1;"].join("\n");
    write(root, "src/broken.ts", Worse);
    const changed = await comparePages([model], { root });
    assert.notEqual(changed[0]?.identity.sources["src/broken.ts"], comparison?.identity.sources["src/broken.ts"]);
    assert.equal(changed[0]?.identity.sources["src/broken.ts"], digest(Worse));
    assert.deepEqual(
      changed[0]?.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.pos?.line]),
      [["drift.symbols-syntax", 5]],
    );

    // Fixing the syntax returns the citation to ordinary behaviour.
    write(root, "src/broken.ts", scanned());
    const fixed = await comparePages([model], { root });
    assert.deepEqual(fixed[0]?.diagnostics.map((diagnostic) => diagnostic.id), []);
    assert.equal(fixed[0]?.identity.sources["src/broken.ts"], digest(scanned()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sources that scan successfully keep their ordinary drift behaviour", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", scanned());
    write(root, "src/empty.ts", "// nothing exported\n");
    write(root, "src/notes.txt", "one line\n");
    const pages = [
      page("clean.md", "Call `buildDocs()` at src/build.ts:2."),
      page("moved.md", "Call `loadConfig()` at src/build.ts:12."),
      page("renamed.md", "Call `parseConfig()` at src/build.ts:2."),
      page("signature.md", "Call `buildDocs(root, mode)` at src/build.ts:2."),
      page("exportless.md", "See src/empty.ts:1."),
      page("gone.md", "See src/gone.ts:1."),
      page("range.md", "See src/notes.txt:9."),
    ];

    const diagnostics = await compare(root, pages);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), [
      "drift.moved-symbol",
      "drift.missing-symbol",
      "drift.signature-mismatch",
      "drift.missing-symbol",
      "drift.missing-file",
      "drift.line-out-of-range",
    ]);
    assert.ok(!diagnostics.some((diagnostic) => diagnostic.id === "drift.symbols-syntax"));
    // None of these findings points anywhere but at its own page.
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.pos?.file), [
      "moved.md",
      "renamed.md",
      "signature.md",
      "exportless.md",
      "gone.md",
      "range.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
