import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { manifest } from "../src/outputs/manifest.ts";

type Schema = {
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

const schema = JSON.parse(readFileSync(new URL("../schema/manifest.schema.json", import.meta.url), "utf8")) as Schema;

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

function page(url: string, kind: Page["kind"] = "doc", frontMatter: Page["frontMatter"] = {}, body = "", html = ""): Page {
  return {
    url,
    source: { ...pos, file: "guide/install.md" },
    frontMatter,
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html,
    markdown: body,
    kind,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The manifest reads only the model, so rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the manifest never renders a page")),
  report: () => {},
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function run(model: Site, context: OutputContext = ctx): Promise<OutputFile> {
  const files = await manifest.run(model, context);
  assert.equal(files.length, 1, "the manifest writes one file");
  return files[0]!;
}

interface Entry {
  readonly url: string;
  readonly source: string;
  readonly title: string;
  readonly layout: string | null;
  readonly outputs: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
}

async function manifestOf(model: Site): Promise<{ version: number; pages: Entry[] }> {
  const text = String((await run(model)).contents);
  return JSON.parse(text) as { version: number; pages: Entry[] };
}

const byUrl = (entries: readonly Entry[]): Map<string, Entry> => new Map(entries.map((e) => [e.url, e]));

test("the output is named after its file and writes .slipway/manifest.json", async () => {
  assert.equal(manifest.name, "manifest");
  const file = await run(site([page("/")]));
  assert.equal(file.path, ".slipway/manifest.json");
  assert.ok(String(file.contents).endsWith("\n"), "the file ends with a line feed");
});

test("the manifest validates against its schema", async () => {
  const text = String((await run(site([page("/"), page("/guide/install/", "doc", { layout: "doc" })]))).contents);
  const parsed: unknown = JSON.parse(text);
  assert.equal(validate(parsed), true, ajv.errorsText(validate.errors));
});

test("fixtures/docs-site lists every doc page, in URL order, with no app page", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const built = await manifestOf(model);

  assert.equal(built.version, 1);
  assert.equal(validate(built), true, ajv.errorsText(validate.errors));

  const docs = model.pages.filter((p) => p.kind === "doc");
  assert.ok(docs.length > 0, "the fixture has doc pages");
  assert.equal(built.pages.length, docs.length, "one entry per doc page");
  assert.ok(!built.pages.some((e) => e.url === "/dashboard/"), "the app page is left out");

  const urls = built.pages.map((e) => e.url);
  assert.deepEqual(urls, [...urls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "pages are sorted by URL code point");

  const quickstart = byUrl(built.pages).get("/quickstart/");
  assert.ok(quickstart, "the fixture has /quickstart/");
  assert.equal(quickstart.source, "quickstart.md");
  assert.equal(quickstart.title, "Quickstart");
  assert.equal(quickstart.layout, null, "the fixture has no mizzen.yml, so no defaults set a layout");
  assert.deepEqual(quickstart.outputs, ["quickstart/index.html", "quickstart/index.md"]);

  const notFound = byUrl(built.pages).get("/404.html");
  assert.ok(notFound, "the 404 page is a page");
  assert.deepEqual(notFound.outputs, ["404.html", "404.md"], "a permalink that names an HTML file keeps its name, and its twin swaps .html for .md");

  const home = byUrl(built.pages).get("/");
  assert.ok(home, "the site root is a page");
  assert.deepEqual(home.outputs, ["index.html", "index.md"], "the site root becomes index.html and index.md");

  // The hashes come from the model alone: no page is rendered a second time for the manifest.
  const quickstartModel = docs.find((p) => p.url === "/quickstart/")!;
  assert.equal(quickstart.hashes.source, sha256(quickstartModel.markdown));
  assert.equal(quickstart.hashes.html, sha256(quickstartModel.html));
  assert.deepEqual(Object.keys(quickstart.hashes), ["source", "html"]);
});

test("the base is stripped from output paths", async () => {
  const model = site(
    [page("/evergreen/", "doc", { layout: "home" }, "# Home", "<h1>Home</h1>"), page("/evergreen/guide/install/", "doc", { layout: "doc" }, "# Install")],
    { base: "/evergreen" },
  );
  const built = await manifestOf(model);

  const home = byUrl(built.pages).get("/evergreen/");
  assert.deepEqual(home?.outputs, ["index.html", "index.md"]);

  const install = byUrl(built.pages).get("/evergreen/guide/install/");
  assert.deepEqual(install?.outputs, ["guide/install/index.html", "guide/install/index.md"]);
  assert.equal(install?.hashes.source, sha256("# Install"));
  assert.equal(install?.hashes.html, sha256(""));
});

test("a page with no layout records null, and an app or asset page is not listed", async () => {
  const built = await manifestOf(
    site([page("/a/"), page("/dashboard/", "app"), page("/logo.svg", "asset")]),
  );
  assert.deepEqual(built.pages.map((e) => e.url), ["/a/"]);
  assert.equal(built.pages[0]?.layout, null);
});

test("a page lists only the outputs its config leaves on", async () => {
  const htmlOff = await manifestOf(site([page("/a/", "doc", { layout: "doc" }, "# A")], { outputs: { html: false } }));
  assert.deepEqual(htmlOff.pages[0]?.outputs, ["a/index.md"], "the twin stays when only the HTML output is off");

  const twinsOff = await manifestOf(site([page("/a/", "doc", { layout: "doc" }, "# A")], { outputs: { twins: false } }));
  assert.deepEqual(twinsOff.pages[0]?.outputs, ["a/index.html"], "the HTML file stays when only the twins output is off");

  const bothOff = await manifestOf(
    site([page("/a/", "doc", { layout: "doc" }, "# A")], { outputs: { html: false, twins: false } }),
  );
  assert.deepEqual(bothOff.pages[0]?.outputs, []);
  assert.deepEqual(Object.keys(bothOff.pages[0]?.hashes ?? {}), ["source", "html"]);
  assert.equal(validate(bothOff), true, ajv.errorsText(validate.errors));
});

test("a URL that names a file other than HTML has no twin, so only the HTML output is listed", async () => {
  const built = await manifestOf(site([page("/feed.xml", "doc", { layout: "doc" }, "<feed/>")]));
  assert.deepEqual(built.pages[0]?.outputs, ["feed.xml"]);
});

test("two runs of the same model write the same bytes", async () => {
  const model = site([page("/b/", "doc", {}, "# B"), page("/a/", "doc", {}, "# A")]);
  assert.equal(String((await run(model)).contents), String((await run(model)).contents));
  assert.deepEqual((await manifestOf(model)).pages.map((e) => e.url), ["/a/", "/b/"]);
});

test("the schema rejects a manifest a tool must not accept", () => {
  const valid = {
    version: 1,
    pages: [
      {
        url: "/a/",
        source: "a.md",
        title: "A",
        layout: "doc",
        outputs: ["a/index.html"],
        hashes: { source: sha256("# A"), html: sha256("<h1>A</h1>") },
      },
    ],
  };
  assert.equal(validate(valid), true, ajv.errorsText(validate.errors));

  const invalid: Array<[string, unknown]> = [
    ["a missing version", { pages: [] }],
    ["another version", { ...valid, version: 0 }],
    ["an unknown top-level key", { ...valid, generator: "mizzen" }],
    ["a page without a source", { version: 1, pages: [{ ...valid.pages[0], source: undefined }] }],
    ["a page with an unknown key", { version: 1, pages: [{ ...valid.pages[0], lang: "en" }] }],
    ["a URL without a leading slash", { version: 1, pages: [{ ...valid.pages[0], url: "a/" }] }],
    ["an output with a leading slash", { version: 1, pages: [{ ...valid.pages[0], outputs: ["/a/index.html"] }] }],
    ["an output with a parent segment", { version: 1, pages: [{ ...valid.pages[0], outputs: ["a/../b.html"] }] }],
    ["a hash that is not SHA-256", { version: 1, pages: [{ ...valid.pages[0], hashes: { source: "abc", html: "abc" } }] }],
    ["hashes without a source", { version: 1, pages: [{ ...valid.pages[0], hashes: { html: sha256("") } }] }],
    ["hashes without an html", { version: 1, pages: [{ ...valid.pages[0], hashes: { source: sha256("") } }] }],
    ["a layout that is not a string or null", { version: 1, pages: [{ ...valid.pages[0], layout: 3 }] }],
    ["a title that is not a string", { version: 1, pages: [{ ...valid.pages[0], title: 3 }] }],
  ];
  for (const [name, document] of invalid) assert.equal(validate(document), false, name);
});
