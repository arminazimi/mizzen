import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Root } from "mdast";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { linksOf, sourcemap } from "../src/outputs/sourcemap.ts";
import { sliceSpan } from "../src/source/spans.ts";

type Schema = {
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

const schema = JSON.parse(
  readFileSync(new URL("../schema/sourcemap.schema.json", import.meta.url), "utf8"),
) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
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

function page(url: string, kind: Page["kind"] = "doc", markdown = ""): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The source map reads only the model, so rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the source map never renders a page")),
  report: () => {},
};

interface Section {
  readonly id: string;
  readonly level: number;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

interface LinkEntry {
  readonly href: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface TargetEntry {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly column?: number;
}

interface ClaimEntry {
  readonly kind: "trust" | "drift";
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly example?: string;
  readonly reference?: string;
  readonly target?: TargetEntry;
}

interface PageEntry {
  readonly url: string;
  readonly source: string;
  readonly sections: readonly Section[];
  readonly links: readonly LinkEntry[];
  readonly claims: readonly ClaimEntry[];
}

interface SourceMap {
  readonly version: number;
  readonly pages: readonly PageEntry[];
}

async function run(model: Site, context: OutputContext = ctx): Promise<OutputFile> {
  const files = await sourcemap.run(model, context);
  assert.equal(files.length, 1, "the source map writes one file");
  return files[0]!;
}

async function mapOf(model: Site): Promise<SourceMap> {
  return JSON.parse(String((await run(model)).contents)) as SourceMap;
}

const byUrl = (entries: readonly PageEntry[]): Map<string, PageEntry> => new Map(entries.map((e) => [e.url, e]));

/** The opening tag of the heading with `id` in a page's HTML, its level, and its attributes. */
function headingTag(html: string, id: string): { level: number; attrs: string } | undefined {
  for (const match of html.matchAll(/<h([1-6])\b([^>]*)>/g)) {
    if (/\bid="([^"]*)"/.exec(match[2]!)?.[1] === id) return { level: Number(match[1]), attrs: match[2]! };
  }
  return undefined;
}

const fixture = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

test("the output is named after its file and writes sourcemap.json", async () => {
  assert.equal(sourcemap.name, "sourcemap");
  const file = await run(site([page("/")]));
  assert.equal(file.path, "sourcemap.json");
  assert.ok(String(file.contents).endsWith("\n"), "the file ends with a line feed");
});

test("fixtures/docs-site writes a map that validates against the schema, with no repeated URL", async () => {
  const { site: model } = await buildModel(fixture);
  const built = await mapOf(model);

  assert.equal(built.version, 0);
  assert.equal(validate(built), true, ajv.errorsText(validate.errors));
  const urls = built.pages.map((entry) => entry.url);
  assert.equal(new Set(urls).size, urls.length, "each url appears once");
});

test("the map lists every doc page of fixtures/docs-site, in URL order, and no app page", async () => {
  const { site: model } = await buildModel(fixture);
  const built = await mapOf(model);

  const docs = model.pages.filter((p) => p.kind === "doc");
  assert.ok(docs.length > 0, "the fixture has doc pages");
  assert.equal(built.pages.length, docs.length, "one entry per doc page");
  assert.ok(!built.pages.some((entry) => entry.url === "/dashboard/"), "the app page is left out");

  const urls = built.pages.map((entry) => entry.url);
  assert.deepEqual(urls, [...urls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "pages are sorted by URL code point");

  const quickstart = byUrl(built.pages).get("/quickstart/");
  assert.ok(quickstart, "the fixture has /quickstart/");
  assert.equal(quickstart.source, "quickstart.md");
  assert.deepEqual(quickstart.sections.map((s) => s.id), ["quickstart", "the-first-deploy", "what-happens-next"]);
  assert.deepEqual(quickstart.links.map((l) => l.href), ["configuration.md", "commands.md", "output.md", "dashboard/"]);

  for (const entry of built.pages) {
    assert.ok(existsSync(join(fixture, entry.source)), `${entry.url} names a source file under the site root`);
    assert.ok(!entry.source.includes("\\"), `${entry.source} uses forward slashes`);
    assert.ok(!entry.source.startsWith("/") && !entry.source.split("/").includes(".."), `${entry.source} is relative`);
  }
});

test("every section's line and level equal the heading's data-src and tag in the built HTML", async () => {
  const { site: model } = await buildModel(fixture);
  const built = await mapOf(model);
  const pages = new Map(model.pages.map((p) => [p.url, p]));

  for (const entry of built.pages) {
    const pageModel = pages.get(entry.url)!;
    assert.equal(entry.sections.length, pageModel.headings.length, `${entry.url} lists every heading`);

    for (const [index, section] of entry.sections.entries()) {
      const heading = pageModel.headings[index]!;
      assert.equal(section.id, heading.id, `${entry.url} section ${index} id`);
      assert.equal(section.level, heading.depth, `${entry.url} section ${index} level`);
      assert.equal(section.text, heading.text, `${entry.url} section ${index} text`);
      assert.equal(section.line, heading.pos.line, `${entry.url} section ${index} line`);

      assert.equal(section.column, heading.pos.column, `${entry.url} section ${index} column`);
      assert.equal(section.endLine, heading.pos.endLine, `${entry.url} section ${index} end line`);
      assert.equal(section.endColumn, heading.pos.endColumn, `${entry.url} section ${index} end column`);

      const tag = headingTag(pageModel.html, section.id);
      assert.ok(tag, `${entry.url} builds a heading with id ${section.id}`);
      assert.equal(tag.level, section.level, `${entry.url} section ${section.id} is an h${section.level}`);
      const dataSrc = /\bdata-src="([^"]*)"/.exec(tag.attrs)?.[1];
      assert.equal(
        dataSrc,
        `${entry.source}:${section.line}:${section.column}-${section.endLine}:${section.endColumn}`,
        `${entry.url} section ${section.id} data-src`,
      );
    }
  }
});

test("every link is written on the source line the map gives", async () => {
  const { site: model } = await buildModel(fixture);
  const built = await mapOf(model);
  const pages = new Map(model.pages.map((p) => [p.url, p]));

  let links = 0;
  for (const entry of built.pages) {
    const pageModel = pages.get(entry.url)!;
    const lines = pageModel.markdown.split(/\r?\n/);
    for (const link of entry.links) {
      links += 1;
      assert.ok(link.line >= pageModel.source.line, `${entry.url} link ${link.href} is after the front matter`);
      const text = lines[link.line - pageModel.source.line] ?? "";
      assert.ok(text.includes(link.href), `${entry.url} line ${link.line} holds ${link.href}`);
    }
  }
  assert.ok(links > 0, "the fixture has links to check");
});

test("links are in document order, one per mention, and a page with no links has an empty list", async () => {
  const linked = page("/links/", "doc", "See [b](b.md) and [a](a.md).\n\nThen [c](c.md).\n");
  const silent = page("/silent/", "doc", "# Silent\n\nNothing to see.\n");
  const built = await mapOf(site([linked, silent]));

  assert.deepEqual(byUrl(built.pages).get("/links/")?.links.map((link) => link.href), ["b.md", "a.md", "c.md"]);
  assert.deepEqual(
    byUrl(built.pages).get("/links/")?.links.map((link) => link.line),
    [1, 1, 3],
    "two links on one line keep their shared line",
  );
  assert.deepEqual(byUrl(built.pages).get("/silent/")?.links, [], "a page with no links still has a links array");
});

/** A claim's span in the page file the test pages use. */
function claimSpan(claim: ClaimEntry): { file: string; line: number; column: number; endLine: number; endColumn: number } {
  return {
    file: "guide/install.md",
    line: claim.line,
    column: claim.column,
    endLine: claim.endLine,
    endColumn: claim.endColumn,
  };
}

test("trust and drift claims carry the exact page span and the cited target", async () => {
  const markdown =
    "# Guide\n\nCall `src/app.ts:12` and `other.md#L3-L4`.\n\n```ts test\nconsole.log(1);\n```\n";
  const built = await mapOf(site([page("/guide/", "doc", markdown)]));
  const entry = byUrl(built.pages).get("/guide/");
  assert.ok(entry);

  assert.deepEqual(entry.claims.map((claim) => claim.kind), ["drift", "drift", "trust"]);
  const [first, second, example] = entry.claims;
  assert.ok(first && second && example);

  assert.equal(first.reference, "guide/src/app.ts:12", "the citation joins drift.json");
  assert.deepEqual(first.target, { file: "guide/src/app.ts", line: 12 });
  assert.equal(sliceSpan(markdown, claimSpan(first)), "`src/app.ts:12`", "the span covers the reference");

  assert.equal(second.reference, "guide/other.md:3-4");
  assert.deepEqual(second.target, { file: "guide/other.md", line: 3, endLine: 4 });
  assert.equal(sliceSpan(markdown, claimSpan(second)), "`other.md#L3-L4`");

  assert.equal(example.example, "example-1", "the example id is the one the example report uses");
  assert.equal(sliceSpan(markdown, claimSpan(example)), "```ts test\nconsole.log(1);\n```", "the span covers the fence");
});

test("claim spans stay exact in a CRLF page with non-ASCII text", async () => {
  const markdown = "# G\r\n\r\nSee 😀 `src/a.ts:1`.\r\n\r\n```ts test\r\nconst s = \"✓\";\r\n```\r\n";
  const built = await mapOf(site([page("/g/", "doc", markdown)]));
  const claims = byUrl(built.pages).get("/g/")?.claims;
  assert.equal(claims?.length, 2);

  assert.equal(sliceSpan(markdown, claimSpan(claims[0]!)), "`src/a.ts:1`", "the reference after the emoji");
  assert.equal(sliceSpan(markdown, claimSpan(claims[1]!)), "```ts test\r\nconst s = \"✓\";\r\n```");
});

test("a claim whose span the page does not have is reported, never written", async () => {
  const diagnostics: Diagnostic[] = [];
  const broken = { ...page("/broken/", "doc", "```ts test\nx\n```\n"), source: { ...pos, line: 0 } };
  const file = await run(site([broken]), { ...ctx, report: (diagnostic) => diagnostics.push(diagnostic) });
  const built = JSON.parse(String(file.contents)) as SourceMap;

  assert.deepEqual(built.pages[0]?.claims, [], "the stale claim is left out");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "sourcemap.stale-range");
  assert.equal(diagnostics[0]?.pos, undefined, "a stale range is not repeated as a location");
});

test("a link without a position is reported, not given a made-up line", () => {
  const diagnostics: Diagnostic[] = [];
  const tree: Root = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "link", url: "a.md", children: [] }] }],
  };

  assert.deepEqual(linksOf(tree, pos, (diagnostic) => diagnostics.push(diagnostic)), []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "sourcemap.missing-position");
  assert.deepEqual(diagnostics[0]?.pos, pos, "the page it belongs to is the location");
});

test("an app page and an asset page are left out, and a page with no headings has an empty sections list", async () => {
  const built = await mapOf(site([page("/a/"), page("/dashboard/", "app"), page("/logo.svg", "asset")]));
  assert.deepEqual(built.pages.map((entry) => entry.url), ["/a/"]);
  assert.deepEqual(built.pages[0]?.sections, []);
  assert.deepEqual(built.pages[0]?.links, []);
  assert.deepEqual(built.pages[0]?.claims, []);
});

test("two runs of the same model write the same bytes", async () => {
  const model = site([
    page("/b/", "doc", "# B\n"),
    page("/c/", "doc", "See `src/a.ts:1`.\n\n```ts test\nx\n```\n"),
    page("/a/", "doc", "# A\n"),
  ]);
  assert.equal(String((await run(model)).contents), String((await run(model)).contents));
  assert.deepEqual(
    (await mapOf(model)).pages.map((entry) => entry.url),
    ["/b/", "/c/", "/a/"],
    "the model's order is kept",
  );
  assert.deepEqual(
    (await mapOf(model)).pages.find((entry) => entry.url === "/c/")?.claims.map((claim) => claim.kind),
    ["drift", "trust"],
    "claims come out in the same order every time",
  );
});

test("the schema rejects a source map a tool must not accept", () => {
  const valid = {
    version: 0,
    pages: [
      {
        url: "/a/",
        source: "a.md",
        sections: [{ id: "a", level: 1, line: 1, text: "A" }],
        links: [{ href: "b.md", line: 3 }],
        claims: [
          { kind: "trust", line: 1, column: 1, endLine: 3, endColumn: 3, example: "example-1" },
          { kind: "drift", line: 5, column: 1, endLine: 5, endColumn: 12, reference: "a.ts:1", target: { file: "a.ts", line: 1 } },
        ],
      },
    ],
  };
  assert.equal(validate(valid), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ version: 0, pages: [] }), true, ajv.errorsText(validate.errors));

  const page = valid.pages[0]!;
  const section = page.sections[0]!;
  const link = page.links[0]!;
  const claim = page.claims[0]!;
  const driftClaim = page.claims[1]!;
  const invalid: Array<[string, unknown]> = [
    ["a missing version", { pages: [] }],
    ["another version", { ...valid, version: 1 }],
    ["an unknown top-level key", { ...valid, generator: "mizzen" }],
    ["a page without a url", { version: 0, pages: [{ ...page, url: undefined }] }],
    ["a URL without a leading slash", { version: 0, pages: [{ ...page, url: "a/" }] }],
    ["a page without a source", { version: 0, pages: [{ ...page, source: undefined }] }],
    ["an empty source", { version: 0, pages: [{ ...page, source: "" }] }],
    ["an absolute source", { version: 0, pages: [{ ...page, source: "/a.md" }] }],
    ["a source with a parent segment", { version: 0, pages: [{ ...page, source: "docs/../a.md" }] }],
    ["a source with a backslash", { version: 0, pages: [{ ...page, source: "docs\\a.md" }] }],
    ["a page with an unknown key", { version: 0, pages: [{ ...page, lang: "en" }] }],
    ["a section without an id", { version: 0, pages: [{ ...page, sections: [{ ...section, id: undefined }] }] }],
    ["an empty section id", { version: 0, pages: [{ ...page, sections: [{ ...section, id: "" }] }] }],
    ["a heading level of 0", { version: 0, pages: [{ ...page, sections: [{ ...section, level: 0 }] }] }],
    ["a heading level of 7", { version: 0, pages: [{ ...page, sections: [{ ...section, level: 7 }] }] }],
    ["a section line of 0", { version: 0, pages: [{ ...page, sections: [{ ...section, line: 0 }] }] }],
    ["a section without text", { version: 0, pages: [{ ...page, sections: [{ ...section, text: undefined }] }] }],
    ["a section with an unknown key", { version: 0, pages: [{ ...page, sections: [{ ...section, endColumns: 1 }] }] }],
    ["an empty link href", { version: 0, pages: [{ ...page, links: [{ ...link, href: "" }] }] }],
    ["a link line of 0", { version: 0, pages: [{ ...page, links: [{ ...link, line: 0 }] }] }],
    ["a link without an href", { version: 0, pages: [{ ...page, links: [{ line: 1 }] }] }],
    ["a link with an unknown key", { version: 0, pages: [{ ...page, links: [{ ...link, text: "B" }] }] }],
    ["a trust claim without an example", { version: 0, pages: [{ ...page, claims: [{ ...claim, example: undefined }] }] }],
    ["a drift claim without a reference", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, reference: undefined }] }] }],
    ["a drift claim without a target", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, target: undefined }] }] }],
    ["an unknown claim kind", { version: 0, pages: [{ ...page, claims: [{ ...claim, kind: "review" }] }] }],
    ["a claim without an end", { version: 0, pages: [{ ...page, claims: [{ ...claim, endLine: undefined }] }] }],
    ["a claim column of 0", { version: 0, pages: [{ ...page, claims: [{ ...claim, column: 0 }] }] }],
    ["a claim with an unknown key", { version: 0, pages: [{ ...page, claims: [{ ...claim, text: "A" }] }] }],
    ["a target line of 0", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, target: { file: "a.ts", line: 0 } }] }] }],
    ["a target with an absolute file", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, target: { file: "/a.ts", line: 1 } }] }] }],
    ["a target with a parent segment", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, target: { file: "docs/../a.ts", line: 1 } }] }] }],
    ["a target with an unknown key", { version: 0, pages: [{ ...page, claims: [{ ...driftClaim, target: { file: "a.ts", line: 1, endLine: 2, column: 1, text: "x" } }] }] }],
  ];
  for (const [name, document] of invalid) assert.equal(validate(document), false, name);
});
