import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import {
  driftReport,
  driftReportOf,
  type DriftFinding,
  type DriftReportBody,
} from "../src/outputs/drift-report.ts";

const schema = JSON.parse(readFileSync(new URL("../schema/drift.schema.json", import.meta.url), "utf8")) as object;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

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

/** A temporary site root holding `files`. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "drift-evidence-"));
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

/** The report a data value would be read from. */
function findingsIn(body: DriftReportBody, url: string): readonly DriftFinding[] {
  return body.pages[url] ?? [];
}

/** A clone the schema tests may mutate without touching the original. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("a computed finding keeps its message, help, documentation span, and target identity", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([
      page("/guide/missing/", "/src/gone.ts:12\n", "guide/missing.md"),
      page("/guide/moved/", "See `/src/app.ts:20`.\n", "guide/moved.md"),
    ]);
    const report = await driftReportOf(model, { root });

    const missing = findingsIn(report, "/guide/missing/")[0]!;
    assert.deepEqual(missing, {
      kind: "drift.missing-file",
      reference: "src/gone.ts:12",
      severity: "warning",
      message: 'Cannot check the reference to "src/gone.ts": the file does not exist.',
      help: "Update the path or restore the file.",
      source: { file: "guide/missing.md", line: 1, column: 1, endLine: 1, endColumn: 15 },
      target: { path: "src/gone.ts", line: 12, identity: "missing" },
    });
    assert.deepEqual(Object.keys(missing), ["kind", "reference", "severity", "message", "help", "source", "target"]);

    // The target identity joins the finding to the page's recorded source identity.
    assert.equal(missing.target?.identity, report.evidence["/guide/missing/"]?.sources?.["src/gone.ts"]);

    const moved = findingsIn(report, "/guide/moved/")[0]!;
    assert.equal(moved.kind, "drift.moved-symbol");
    assert.equal(moved.source?.file, "guide/moved.md");
    assert.equal(moved.source?.line, 1);
    assert.match(moved.message ?? "", /nearest is "buildDocs" at line 2/);
    assert.equal(moved.help, "Point the reference at line 2, or update the page to match the code.");
    assert.equal(moved.target?.path, "src/app.ts");
    assert.equal(moved.target?.line, 20);
    assert.match(moved.target?.identity ?? "", /^[0-9a-f]{64}$/);
    assert.equal(moved.target?.identity, report.evidence["/guide/moved/"]?.sources?.["src/app.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage keeps zero findings, stored findings, stale, unavailable, and no evidence distinct", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const clean = site([page("/guide/clean/", "# Clean\n\nNo reference here.\n", "guide/clean.md")]);
    const cleanReport = await driftReportOf(clean, { root });
    assert.deepEqual(cleanReport.pages, {});
    assert.deepEqual(cleanReport.coverage["/guide/clean/"], { checked: true, findings: 0 });
    assert.equal(cleanReport.evidence["/guide/clean/"]?.state, "fresh");

    const unchecked = await driftReportOf(clean);
    assert.deepEqual(unchecked.coverage["/guide/clean/"], { checked: false, findings: 0 });
    assert.equal(unchecked.evidence["/guide/clean/"]?.state, "unknown");

    const stored = site([page("/guide/stored/", "# Stored\n", "guide/stored.md")], {
      drift: { "/guide/stored/": [{ kind: "site.checked", reference: "src/app.ts:2" }] },
    });
    const storedReport = await driftReportOf(stored, { root });
    assert.deepEqual(storedReport.coverage["/guide/stored/"], { checked: false, findings: 1 });
    assert.equal(storedReport.evidence["/guide/stored/"]?.state, "unknown");

    const model = site([page("/guide/moved/", "See `/src/app.ts:20`.\n", "guide/moved.md")]);
    const fresh = await driftReportOf(model, { root });
    assert.deepEqual(fresh.coverage["/guide/moved/"], { checked: true, findings: 1 });

    const stale = await driftReportOf(model, { data: fresh });
    assert.deepEqual(stale.coverage["/guide/moved/"], { checked: false, findings: 1 });
    assert.equal(stale.evidence["/guide/moved/"]?.state, "unavailable");

    const edited = site([page("/guide/moved/", "See `/src/app.ts:20` again.\n", "guide/moved.md")]);
    const editedReport = await driftReportOf(edited, { data: fresh });
    assert.deepEqual(editedReport.coverage["/guide/moved/"], { checked: false, findings: 1 });
    assert.equal(editedReport.evidence["/guide/moved/"]?.state, "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the schema accepts the emitted report and rejects malformed spans, states, hashes, and counts", async () => {
  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([
      page("/guide/missing/", "/src/gone.ts:12\n", "guide/missing.md"),
      page("/guide/clean/", "# Clean\n", "guide/clean.md"),
    ]);
    const report = await driftReportOf(model, { root });
    assert.equal(validate(report), true, JSON.stringify(validate.errors));

    const spanLine = clone(report);
    // A span's line is 1-based, so zero is malformed.
    (spanLine.pages["/guide/missing/"]![0]!.source as { line: number }).line = 0;
    assert.equal(validate(spanLine), false, "line 0 is rejected");

    const spanMissing = clone(report);
    delete (spanMissing.pages["/guide/missing/"]![0]!.source as { endColumn?: number }).endColumn;
    assert.equal(validate(spanMissing), false, "a span without an end is rejected");

    const state = clone(report);
    (state.evidence["/guide/clean/"] as { state: string }).state = "maybe";
    assert.equal(validate(state), false, "an unknown evidence state is rejected");

    const content = clone(report);
    (content.evidence["/guide/clean/"] as { content: string }).content = "not-a-hash";
    assert.equal(validate(content), false, "a malformed content hash is rejected");

    const sourceHash = clone(report);
    (sourceHash.evidence["/guide/missing/"]!.sources as Record<string, string>)["src/gone.ts"] = "deadbeef";
    assert.equal(validate(sourceHash), false, "a malformed source hash is rejected");

    const negative = clone(report);
    (negative.coverage["/guide/clean/"] as { findings: number }).findings = -1;
    assert.equal(validate(negative), false, "a negative count is rejected");

    const fractional = clone(report);
    (fractional.coverage["/guide/clean/"] as { findings: number }).findings = 1.5;
    assert.equal(validate(fractional), false, "a fractional count is rejected");

    const extra = clone(report);
    (extra.pages["/guide/missing/"]![0] as unknown as Record<string, unknown>).detail = "not allowed";
    assert.equal(validate(extra), false, "an unknown finding key is rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical inputs write byte-identical reports with no absolute path or wall-clock value", async () => {
  const root = tree({ "src/app.ts": source() });
  const previous = process.env.MIZZEN_SITE_ROOT;
  process.env.MIZZEN_SITE_ROOT = root;
  try {
    const model = site(
      [
        page("/guide/b/", "See `/src/app.ts:20`.\n", "guide/b.md"),
        page("/guide/a/", "See `/src/missing.ts:3`.\n", "guide/a.md"),
      ],
      { drift: { "/guide/b/": [{ kind: "site.kept", reference: "src/app.ts:2", severity: "info" }] } },
    );

    const first: OutputFile = (await driftReport.run(model, ctx))[0]!;
    const second: OutputFile = (await driftReport.run(model, ctx))[0]!;
    assert.equal(String(first.contents), String(second.contents));

    const text = String(first.contents);
    assert.ok(text.endsWith("\n"), "the file ends with a line feed");
    assert.ok(!text.includes(root), "no absolute site root is written");
    assert.ok(!text.includes(tmpdir()), "no temporary folder is written");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no wall-clock instant is written");

    const body = JSON.parse(text) as DriftReportBody;
    assert.deepEqual(Object.keys(body), ["pages", "coverage", "evidence"]);
    assert.deepEqual(Object.keys(body.coverage), ["/guide/a/", "/guide/b/"]);
    assert.deepEqual(Object.keys(body.evidence), ["/guide/a/", "/guide/b/"]);
    assert.deepEqual(Object.keys(body.pages), ["/guide/a/", "/guide/b/"]);
  } finally {
    if (previous === undefined) delete process.env.MIZZEN_SITE_ROOT;
    else process.env.MIZZEN_SITE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing site.data.drift inputs keep working in both shapes and survive a round trip", async () => {
  const bare = await driftReportOf(
    site([page("/a/")], { drift: { "/a/": [{ id: "drift.moved-symbol", path: "src/app.ts:40-42" }] } }),
  );
  assert.deepEqual(bare.pages["/a/"], [
    { kind: "drift.moved-symbol", reference: "src/app.ts:40-42", severity: "warning" },
  ]);
  assert.deepEqual(bare.coverage["/a/"], { checked: false, findings: 1 });

  const nested = await driftReportOf(
    site([page("/b/")], {
      drift: { pages: { "/b/": [{ kind: "drift.missing-file", reference: "src/b.ts:1", severity: "error" }] } },
    }),
  );
  assert.deepEqual(nested.pages["/b/"], [
    { kind: "drift.missing-file", reference: "src/b.ts:1", severity: "error" },
  ]);

  const root = tree({ "src/app.ts": source() });
  try {
    const model = site([page("/guide/", "See `/src/app.ts:20`.\n", "guide/index.md")]);
    const measured = await driftReportOf(model, { root });
    const reread = await driftReportOf(model, { root, data: measured });
    assert.deepEqual(reread, measured, "a written report reads back unchanged through site.data.drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stored finding may carry the evidence fields a previous report wrote", async () => {
  const finding = {
    kind: "drift.missing-file",
    reference: "src/gone.ts:3",
    severity: "warning",
    message: "Cannot check the reference.",
    help: "Restore the file.",
    source: { file: "guide/index.md", line: 4, column: 1, endLine: 4, endColumn: 8 },
    target: { path: "src/gone.ts", line: 3, identity: "missing" },
  };
  const report = await driftReportOf(site([page("/guide/")], { drift: { "/guide/": [finding] } }));
  assert.deepEqual(report.pages["/guide/"], [finding]);
  assert.deepEqual(report.coverage["/guide/"], { checked: false, findings: 1 });
});
