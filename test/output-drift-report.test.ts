import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { driftPagesOf, driftReport, driftRoot } from "../src/outputs/drift-report.ts";

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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the output is named after the file it comes from and writes drift.json", async () => {
  assert.equal(driftReport.name, "drift-report");

  const file = await only(site([]));
  assert.equal(file.path, "drift.json");
});

test("a site with no findings writes exactly { pages: {} } with a trailing line feed", async () => {
  const model = site([page("/guide/install/", "# Install\n\nNothing to check here.\n")]);
  const file = await only(model);
  const text = String(file.contents);

  assert.deepEqual(JSON.parse(text), { pages: {} });
  assert.equal(text, '{\n  "pages": {}\n}\n');
  assert.ok(text.endsWith("\n"), "the file ends with a line feed");
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
  const root = tree();
  try {
    const model = site(
      [
        page("/guide/b/", "# B\n\nSee `/src/z.ts:9` and `/src/a.ts:3`.\n", "guide/b.md"),
        page("/guide/a/", "# A\n\nSee `/src/a.ts:3`.\n", "guide/a.md"),
      ],
      { drift: { "/guide/a/": [{ kind: "site.kind", reference: "src/a.ts:3", severity: "info" }] } },
    );
    const first = await driftPagesOf(model, { root });
    const second = await driftPagesOf(model, { root });
    assert.deepEqual(first, second);
    assert.equal(`${JSON.stringify({ pages: first }, null, 2)}\n`, `${JSON.stringify({ pages: second }, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("driftRoot reads MIZZEN_SITE_ROOT and falls back to the working directory", () => {
  assert.equal(driftRoot({ MIZZEN_SITE_ROOT: "  /tmp/site  " }), "/tmp/site");
  assert.equal(driftRoot({ MIZZEN_SITE_ROOT: "   " }), process.cwd());
  assert.equal(driftRoot({}), process.cwd());
});
