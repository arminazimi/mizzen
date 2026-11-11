import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { driftPagesOf, driftReport, driftReportOf, driftRoot } from "../src/outputs/drift-report.ts";

const POS = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
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
    ...overrides,
  };
}

/** One doc page whose Markdown body starts on line 1, with the given source file. */
function page(url: string, markdown = "# Page\n", file = POS.file): Page {
  return {
    url,
    source: { ...POS, file },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [] as Heading[],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
  return { config: config(), pages, nav: {}, data };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the drift report never renders a page")),
  report: () => {},
};

/** The single `drift.json` file the output writes. */
async function only(model: Site): Promise<OutputFile> {
  const files = await driftReport.run(model, ctx);
  assert.equal(files.length, 1, "the drift report writes one file");
  return files[0]!;
}

/** A temporary site root holding `files`. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "drift-report-"));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A TypeScript file with `buildDocs` on line 2. */
function source(): string {
  return ["// helpers", "export function buildDocs() {", "  return 1;", "}"].join("\n");
}

/** The same declaration moved to line 20. */
function shiftedSource(): string {
  return `${"\n".repeat(19)}export function buildDocs() {}\n`;
}

test("the output is named after the file it comes from and writes drift.json", async () => {
  assert.equal(driftReport.name, "drift-report");

  const file = await only(site([]));
  assert.equal(file.path, "drift.json");
});

test("a site with no pages writes exactly empty pages and evidence with a trailing line feed", async () => {
  const file = await only(site([]));
  const text = String(file.contents);

  assert.equal(text, '{\n  "pages": {},\n  "evidence": {}\n}\n');
  assert.ok(text.endsWith("\n"), "the file ends with a line feed");
});

test("a page with no findings is left out of pages and carries fresh evidence", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([
      page("/guide/install/", "# Install\n\nSee `/src/app.ts:2` for the entry point.\n", "guide/install.md"),
    ]);
    const report = await driftReportOf(model, { root });
    assert.deepEqual(report.pages, {});
    assert.deepEqual(Object.keys(report.pages), []);

    const evidence = report.evidence["/guide/install/"]!;
    assert.equal(evidence.version, 1);
    assert.equal(evidence.state, "fresh");
    assert.match(evidence.content ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(evidence.sources ?? {}), ["src/app.ts"]);
    assert.match(evidence.sources?.["src/app.ts"] ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(evidence), ["version", "state", "content", "sources"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N09's findings are grouped by page URL with kind, reference, and severity", async () => {
  const root = tree();
  try {
    const model = site([
      page("/guide/install/", "# Install\n\nSee `/src/missing.ts:12` for the option.\n", "guide/install.md"),
      page("/guide/clean/", "# Clean\n\nNo reference here.\n", "guide/clean.md"),
    ]);
    const pages = await driftPagesOf(model, { root });

    assert.deepEqual(Object.keys(pages), ["/guide/install/"]);
    assert.deepEqual(pages["/guide/install/"], [
      { kind: "drift.missing-file", reference: "src/missing.ts:12", severity: "warning" },
    ]);
    assert.deepEqual(Object.keys(pages["/guide/install/"]![0]!), ["kind", "reference", "severity"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the output reads the drift checks through MIZZEN_SITE_ROOT", async () => {
  const root = tree();
  const previous = process.env.MIZZEN_SITE_ROOT;
  process.env.MIZZEN_SITE_ROOT = root;
  try {
    const model = site([page("/guide/install/", "# Install\n\nSee `/src/missing.ts:3`.\n", "guide/install.md")]);
    const text = String((await only(model)).contents);
    const body = JSON.parse(text) as { pages: Record<string, unknown> };
    assert.deepEqual(body.pages, {
      "/guide/install/": [{ kind: "drift.missing-file", reference: "src/missing.ts:3", severity: "warning" }],
    });
  } finally {
    if (previous === undefined) delete process.env.MIZZEN_SITE_ROOT;
    else process.env.MIZZEN_SITE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site's drift data wins over the computed findings, including an empty list", async () => {
  const root = tree();
  try {
    const model = site(
      [
        page("/a/", "# A\n\nSee `/src/missing.ts:1`.\n", "a.md"),
        page("/b/", "# B\n\nSee `/src/missing.ts:1`.\n", "b.md"),
      ],
      {
        drift: {
          pages: {
            "/a/": [{ kind: "site.own-kind", reference: "src/kept.ts:7", severity: "error" }],
            "/b/": [],
          },
        },
      },
    );
    const pages = await driftPagesOf(model, { root });
    assert.deepEqual(pages, {
      "/a/": [{ kind: "site.own-kind", reference: "src/kept.ts:7", severity: "error" }],
    });

    // Hand-written findings carry no identity: they are an override with unknown evidence, never fresh.
    const report = await driftReportOf(model, { root });
    assert.equal(report.evidence["/a/"]?.state, "unknown");
    assert.equal(report.evidence["/b/"]?.state, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drift data accepts a diagnostic's id and path, and a missing severity reads as warning", async () => {
  const model = site([page("/a/")], {
    drift: { "/a/": [{ id: "drift.moved-symbol", path: "src/app.ts:40-42" }] },
  });
  const pages = await driftPagesOf(model);
  assert.deepEqual(pages, {
    "/a/": [{ kind: "drift.moved-symbol", reference: "src/app.ts:40-42", severity: "warning" }],
  });
});

test("malformed drift data is ignored and the computed findings are written instead", async () => {
  const root = tree();
  try {
    const model = site([page("/a/", "# A\n\nSee `/src/gone.ts:5`.\n", "a.md")], {
      drift: { "/a/": [{ message: "not a finding" }] },
    });
    const pages = await driftPagesOf(model, { root });
    assert.deepEqual(pages, {
      "/a/": [{ kind: "drift.missing-file", reference: "src/gone.ts:5", severity: "warning" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("page keys and findings are sorted by code point, reference before kind", async () => {
  const model = site([
    page("/b/", "# B\n", "b.md"),
    page("/a/", "# A\n", "a.md"),
  ]);
  const pages = await driftPagesOf(model, {
    data: {
      pages: {
        "/b/": [
          { kind: "drift.moved-symbol", reference: "src/z.ts:9", severity: "warning" },
          { kind: "drift.missing-symbol", reference: "src/a.ts:3", severity: "warning" },
          { kind: "drift.missing-file", reference: "src/a.ts:3", severity: "warning" },
        ],
        "/a/": [{ kind: "drift.missing-file", reference: "src/a.ts:3", severity: "info" }],
      },
    },
  });

  assert.deepEqual(Object.keys(pages), ["/a/", "/b/"]);
  assert.deepEqual(pages["/b/"], [
    { kind: "drift.missing-file", reference: "src/a.ts:3", severity: "warning" },
    { kind: "drift.missing-symbol", reference: "src/a.ts:3", severity: "warning" },
    { kind: "drift.moved-symbol", reference: "src/z.ts:9", severity: "warning" },
  ]);
});

test("two runs over the same site model write the same bytes", async () => {
  const root = tree({ "src/a.ts": source() });
  try {
    const model = site(
      [
        page("/guide/b/", "# B\n\nSee `/src/z.ts:9` and `/src/a.ts:3`.\n", "guide/b.md"),
        page("/guide/a/", "# A\n\nSee `/src/a.ts:2`.\n", "guide/a.md"),
      ],
      { drift: { "/guide/a/": [{ kind: "site.kind", reference: "src/a.ts:3", severity: "info" }] } },
    );
    const first = await driftReportOf(model, { root });
    const second = await driftReportOf(model, { root });
    assert.deepEqual(first, second);
    assert.equal(`${JSON.stringify(first, null, 2)}\n`, `${JSON.stringify(second, null, 2)}\n`);
    assert.deepEqual(Object.keys(first), ["pages", "evidence"]);
    assert.deepEqual(Object.keys(first.evidence), ["/guide/a/", "/guide/b/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence that still matches is reused, so a stored finding survives unchanged", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:20`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });
    assert.equal(stored.pages["/guide/"]?.[0]?.kind, "drift.moved-symbol");

    // A finding the site states itself, under evidence this build just measured for the same bytes.
    const data = {
      pages: { "/guide/": [{ kind: "site.checked", reference: "src/app.ts:20", severity: "info" }] },
      evidence: stored.evidence,
    };
    const reused = await driftReportOf(model, { root, data });
    assert.deepEqual(reused.pages["/guide/"], [
      { kind: "site.checked", reference: "src/app.ts:20", severity: "info" },
    ]);
    assert.equal(reused.evidence["/guide/"]?.state, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed pages never let stored evidence suppress a current finding", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:20`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });
    assert.equal(stored.evidence["/guide/"]?.state, "fresh");

    // The pages half is unusable, so the evidence has nothing to vouch for: the root is checked again.
    const data = { pages: { "/guide/": "not a findings list" }, evidence: stored.evidence };
    const report = await driftReportOf(model, { root, data });

    assert.deepEqual(report.pages["/guide/"], [
      { kind: "drift.moved-symbol", reference: "src/app.ts:20", severity: "warning" },
    ]);
    assert.equal(report.evidence["/guide/"]?.state, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed page content invalidates stored evidence and recomputes the findings", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const before = page("/guide/", "# Guide\n\nSee `/src/app.ts:20`.\n", "guide/index.md");
    const stored = await driftReportOf(site([before]), { root });
    assert.equal(stored.evidence["/guide/"]?.state, "fresh");

    const data = {
      pages: { "/guide/": [{ kind: "site.checked", reference: "src/app.ts:20", severity: "info" }] },
      evidence: stored.evidence,
    };
    // The page now cites the declaration itself, so both the stored content and its finding are stale.
    const after = page("/guide/", "# Guide\n\nSee `/src/app.ts:2`.\n", "guide/index.md");
    const refreshed = await driftReportOf(site([after]), { root, data });

    assert.deepEqual(refreshed.pages, {});
    assert.equal(refreshed.evidence["/guide/"]?.state, "fresh");
    assert.notEqual(refreshed.evidence["/guide/"]?.content, stored.evidence["/guide/"]?.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed source bytes invalidate stored evidence and the new finding names the moved line", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:2`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });
    assert.deepEqual(stored.pages, {});

    write(root, "src/app.ts", shiftedSource());
    const data = {
      pages: { "/guide/": [{ kind: "site.checked", reference: "src/app.ts:2", severity: "info" }] },
      evidence: stored.evidence,
    };
    const refreshed = await driftReportOf(model, { root, data });

    assert.deepEqual(refreshed.pages["/guide/"], [
      { kind: "drift.moved-symbol", reference: "src/app.ts:2", severity: "warning" },
    ]);
    assert.equal(refreshed.evidence["/guide/"]?.state, "fresh");
    assert.notEqual(
      refreshed.evidence["/guide/"]?.sources?.["src/app.ts"],
      stored.evidence["/guide/"]?.sources?.["src/app.ts"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted source invalidates stored evidence and is reported at the cited path", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:2`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });
    assert.deepEqual(stored.pages, {});

    rmSync(join(root, "src/app.ts"));
    const data = {
      pages: { "/guide/": [{ kind: "site.checked", reference: "src/app.ts:2", severity: "info" }] },
      evidence: stored.evidence,
    };
    const refreshed = await driftReportOf(model, { root, data });

    assert.deepEqual(refreshed.pages["/guide/"], [
      { kind: "drift.missing-file", reference: "src/app.ts:2", severity: "warning" },
    ]);
    assert.equal(refreshed.evidence["/guide/"]?.sources?.["src/app.ts"], "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a renamed source invalidates stored evidence and the finding keeps the old path", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:2`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });

    renameSync(join(root, "src/app.ts"), join(root, "src/renamed.ts"));
    const data = {
      pages: { "/guide/": [{ kind: "site.checked", reference: "src/app.ts:2", severity: "info" }] },
      evidence: stored.evidence,
    };
    const refreshed = await driftReportOf(model, { root, data });

    assert.deepEqual(refreshed.pages["/guide/"], [
      { kind: "drift.missing-file", reference: "src/app.ts:2", severity: "warning" },
    ]);
    assert.equal(refreshed.evidence["/guide/"]?.sources?.["src/app.ts"], "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a root, changed content marks the stored evidence stale, never fresh", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const before = page("/guide/", "# Guide\n\nSee `/src/app.ts:20`.\n", "guide/index.md");
    const stored = await driftReportOf(site([before]), { root });
    assert.equal(stored.pages["/guide/"]?.[0]?.kind, "drift.moved-symbol");

    const after = page("/guide/", "# Guide\n\nSee `/src/app.ts:2`.\n", "guide/index.md");
    const stale = await driftReportOf(site([after]), { data: stored });

    // The entry is kept, because no root lets the engine recompute it, but it is not claimed fresh.
    assert.deepEqual(stale.pages, stored.pages);
    assert.equal(stale.evidence["/guide/"]?.state, "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a root, matching content is unavailable because its sources cannot be confirmed", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "# Guide\n\nSee `/src/app.ts:20`.\n", "guide/index.md")]);
    const stored = await driftReportOf(model, { root });

    const unchecked = await driftReportOf(model, { data: stored });
    assert.deepEqual(unchecked.pages, stored.pages);
    assert.equal(unchecked.evidence["/guide/"]?.state, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page the engine could not check has unknown evidence, never fresh", async () => {
  const model = site([page("/guide/", "# Guide\n\nSee `/src/gone.ts:1`.\n", "guide/index.md")]);
  const report = await driftReportOf(model);

  assert.deepEqual(report.pages, {});
  assert.deepEqual(report.evidence["/guide/"], { version: 1, state: "unknown" });
});


test("driftRoot reads MIZZEN_SITE_ROOT and falls back to the working directory", () => {
  assert.equal(driftRoot({ MIZZEN_SITE_ROOT: "  /tmp/site  " }), "/tmp/site");
  assert.equal(driftRoot({ MIZZEN_SITE_ROOT: "   " }), process.cwd());
  assert.equal(driftRoot({}), process.cwd());
});
