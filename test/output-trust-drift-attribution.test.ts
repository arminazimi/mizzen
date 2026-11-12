import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import { comparePages } from "../src/drift/compare.ts";
import { trustReport, type TrustPageEntry } from "../src/outputs/trust.ts";

/**
 * Issue #144: a drift finding that points inside the cited target, such as a scanner failure, must count
 * against the page whose citation earned it, not against the target file.
 */

/** A site config with the defaults a build fills in. */
function config(): SiteConfig {
  return {
    title: "Example",
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
}

/** One doc page whose body starts on line 1, with the given source file. */
function page(url: string, markdown: string, file: string): Page {
  return {
    url,
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  return { config: config(), pages, nav: {}, data: {} };
}

/** The single `trust.json` file the report writes. */
async function reportOf(model: Site, root: string): Promise<OutputFile> {
  const files = await trustReport(model, { root });
  assert.equal(files.length, 1, "the report writes one file");
  return files[0]!;
}

/** The report's page entries, keyed by URL. */
function pagesOf(file: OutputFile): Record<string, TrustPageEntry> {
  return (JSON.parse(String(file.contents)) as { pages: Record<string, TrustPageEntry> }).pages;
}

/** A temporary site tree; the caller removes it. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "trust-drift-attribution-"));
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

/** A TypeScript file whose last comment never closes, so the scanner fails at line 4, column 1. */
const BROKEN = ["export function buildDocs() {", "  return 1;", "}", "/* never closed"].join("\n");

test("a scanner failure counts against the citing page, not the cited target", async () => {
  const root = tree({ "src/broken.ts": BROKEN });
  try {
    const model = page("/guide/setup/", "Call `buildDocs()` at src/broken.ts:1.", "setup.md");
    const entry = pagesOf(await reportOf(site([model]), root))["/guide/setup/"]!;

    // Before this fix the finding's position in `src/broken.ts` left the citing page with a clean zero.
    assert.deepEqual(entry.factors[1], {
      signal: "drift",
      code: "drift.findings",
      state: "negative",
      value: 1,
    });
    assert.equal(entry.evidence.drift, "measured");
    assert.equal(entry.level, "at-risk");
    assert.deepEqual(entry.reasons[1], {
      code: "drift.findings",
      message: "1 drift finding: the page no longer matches the code it cites.",
    });
    // Provenance names the page's source file, never the target the finding points into.
    assert.deepEqual(entry.provenance.drift, {
      source: "computed",
      availability: "available",
      input: "setup.md",
    });

    // The underlying finding still names the cited target and keeps its real position inside it.
    const [comparison] = await comparePages([model], { root });
    assert.equal(comparison?.findings.length, 1);
    assert.equal(comparison?.findings[0]?.reference.path, "src/broken.ts");
    assert.deepEqual(comparison?.diagnostics[0]?.pos, {
      file: "src/broken.ts",
      line: 4,
      column: 1,
      endLine: 4,
      endColumn: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple citations keep deterministic counts and unrelated pages keep zero", async () => {
  const root = tree({ "src/broken.ts": BROKEN });
  try {
    const model = site([
      page("/a/", "See src/broken.ts:1.", "a.md"),
      page("/b/", "See src/broken.ts:1.\n\nAnd `buildDocs()` at src/broken.ts:4.", "b.md"),
      page("/c/", "# No citations\n", "c.md"),
    ]);
    const first = await reportOf(model, root);
    const second = await reportOf(model, root);

    assert.equal(first.contents, second.contents, "two runs write the same bytes");
    const pages = pagesOf(first);
    assert.deepEqual(
      ["/a/", "/b/", "/c/"].map((url) => [pages[url]!.factors[1]!.code, pages[url]!.factors[1]!.value]),
      [
        ["drift.findings", 1],
        ["drift.findings", 2],
        ["drift.clean", 0],
      ],
    );
    assert.equal(pages["/c/"]!.reasons[1]!.code, "drift.clean", "an unrelated page inherits no findings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target-side and page-local findings count together, each keeping its own position", async () => {
  const root = tree({ "src/broken.ts": BROKEN });
  try {
    const model = page(
      "/guide/setup/",
      "See src/gone.ts:1.\n\nCall `buildDocs()` at src/broken.ts:1.",
      "setup.md",
    );
    const entry = pagesOf(await reportOf(site([model]), root))["/guide/setup/"]!;

    assert.equal(entry.factors[1]!.code, "drift.findings");
    assert.equal(entry.factors[1]!.value, 2);
    assert.deepEqual(entry.provenance.drift, {
      source: "computed",
      availability: "available",
      input: "setup.md",
    });

    const [comparison] = await comparePages([model], { root });
    assert.deepEqual(
      comparison?.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.pos?.file]),
      [
        ["drift.missing-file", "setup.md"],
        ["drift.symbols-syntax", "src/broken.ts"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
