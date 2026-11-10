import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { pageJson } from "../src/outputs/page-json.ts";

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

function heading(depth: Heading["depth"], id: string, text: string): Heading {
  return { depth, id, text, pos };
}

function page(url: string, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The page JSON reads no render host and reports nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the page JSON never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return pageJson.run(model, ctx);
}

async function only(model: Site): Promise<OutputFile> {
  const files = await run(model);
  assert.equal(files.length, 1, "one page writes one file");
  return files[0]!;
}

/** The path the contract gives a page URL, restated from the contract instead of imported. */
function expectedPath(url: string, base = ""): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  const path = /\.html?$/i.test(last)
    ? `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".json")}`
    : last.includes(".")
      ? undefined
      : `${url.endsWith("/") ? url : `${url}/`}index.json`;
  if (path === undefined) return undefined;
  const under = base !== "" && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || "/" : path;
  return under.replace(/^\//, "");
}

test("the output is named after its file", () => {
  assert.equal(pageJson.name, "page-json");
});

test("a pretty URL writes index.json inside its folder, the root at index.json, and an HTML file as its .json name", async () => {
  const pretty = await only(site([page("/guide/install/")]));
  assert.equal(pretty.path, "guide/install/index.json");

  const root = await only(site([page("/")]));
  assert.equal(root.path, "index.json");

  const notFound = await only(site([page("/404.html")]));
  assert.equal(notFound.path, "404.json", "an HTML file swaps .html for .json");
});

test("a URL that names a file of another kind has no page JSON", async () => {
  assert.deepEqual(await run(site([page("/feed.xml")])), []);
});

test("a page records its URL, title, description, headings, source, last change, and token count", async () => {
  const file = await only(
    site([
      page("/guide/install/", {
        title: "Install",
        frontMatter: { description: "  How to install.  ", last_modified_at: "2026-03-04" },
        headings: [heading(1, "install", "Install"), heading(3, "requirements", "Requirements")],
        source: { ...pos, file: "guide/install.md" },
        markdown: "123456789",
      }),
    ]),
  );

  const body = JSON.parse(String(file.contents)) as Record<string, unknown>;
  assert.deepEqual(body, {
    url: "/guide/install/",
    title: "Install",
    description: "How to install.",
    headings: [
      { depth: 1, id: "install", text: "Install" },
      { depth: 3, id: "requirements", text: "Requirements" },
    ],
    source: "guide/install.md",
    lastModified: "2026-03-04",
    tokens: 3,
  });
  assert.deepEqual(Object.keys(body), ["url", "title", "description", "headings", "source", "lastModified", "tokens"]);
  assert.ok(String(file.contents).endsWith("\n"), "the file ends with a line feed");
});

test("the token count is the Markdown length divided by four, rounded up", async () => {
  const cases: ReadonlyArray<[string, number]> = [
    ["", 0],
    ["a", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["# Title\n\nOne paragraph.\n", 6],
  ];
  for (const [markdown, tokens] of cases) {
    const file = await only(site([page("/a/", { markdown })]));
    assert.equal((JSON.parse(String(file.contents)) as { tokens: number }).tokens, tokens, JSON.stringify(markdown));
  }
});

test("a page without a description or last change records null, and a date that is not a date records null", async () => {
  const missing = JSON.parse(String((await only(site([page("/a/")]))).contents)) as Record<string, unknown>;
  assert.equal(missing.description, null);
  assert.equal(missing.lastModified, null);
  assert.equal(missing.tokens, 0);

  const unreadable = JSON.parse(
    String((await only(site([page("/a/", { frontMatter: { last_modified_at: "yesterday" } })]))).contents),
  ) as Record<string, unknown>;
  assert.equal(unreadable.lastModified, null, "an unparseable value is no date");

  const blank = JSON.parse(
    String((await only(site([page("/a/", { frontMatter: { description: "   " } })]))).contents),
  ) as Record<string, unknown>;
  assert.equal(blank.description, null, "whitespace is no description");
});

test("a last change the front matter parser gives as a Date becomes its ISO date", async () => {
  const file = await only(site([page("/a/", { frontMatter: { last_modified_at: new Date("2026-03-04T12:30:00Z") } })]));
  const body = JSON.parse(String(file.contents)) as { lastModified: string | null };
  assert.equal(body.lastModified, "2026-03-04");
});

test("the base is stripped from the file path, and the URL keeps it", async () => {
  const files = await run(
    site([page("/evergreen/"), page("/evergreen/guide/install/")], { base: "/evergreen" }),
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["guide/install/index.json", "index.json"],
  );
  const install = JSON.parse(String(files[0]!.contents)) as { url: string };
  assert.equal(install.url, "/evergreen/guide/install/");
});

test("an app page, an asset page, and a site root marked app write no page JSON", async () => {
  const files = await run(site([page("/guide/"), page("/dashboard/", { kind: "app" }), page("/logo.svg", { kind: "asset" })]));
  assert.deepEqual(
    files.map((f) => f.path),
    ["guide/index.json"],
  );
});

test("fixtures/docs-site gets one page JSON per doc page, with its real headings and source, and no app page", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const files = (await run(model)).map((file) => [file.path, file.contents] as const);
  const byPath = new Map(files);

  const docs = model.pages.filter((p) => p.kind === "doc" && expectedPath(p.url) !== undefined);
  assert.ok(docs.length > 0, "the fixture has doc pages");
  assert.ok(docs.some((p) => p.url === "/quickstart/"), "the fixture has a doc at /quickstart/");
  assert.ok(model.pages.some((p) => p.kind === "app" && p.url === "/dashboard/"), "the fixture has an app page");

  assert.equal(files.length, docs.length, "one file per doc page that has an index.json address");
  for (const p of docs) {
    const contents = byPath.get(expectedPath(p.url)!);
    assert.ok(contents, `missing index.json for ${p.url}`);
    const body = JSON.parse(String(contents)) as {
      url: string;
      title: string;
      headings: ReadonlyArray<{ depth: number; id: string; text: string }>;
      source: string;
      tokens: number;
    };
    assert.equal(body.url, p.url);
    assert.equal(body.title, p.title);
    assert.equal(body.source, p.source.file);
    assert.deepEqual(
      body.headings,
      p.headings.map(({ depth, id, text }) => ({ depth, id, text })),
      `${p.url} carries the model's headings in order`,
    );
    assert.equal(body.tokens, Math.ceil(p.markdown.length / 4));
  }

  assert.ok(byPath.has("install/index.json"), "a pretty URL writes inside its folder");
  assert.ok(byPath.has("404.json"), "a URL that names an HTML file becomes its .json name");
  assert.ok(![...byPath.keys()].some((path) => path.startsWith("dashboard/")), "the app page writes nothing");

  const paths = files.map(([path]) => path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "files are sorted by path code point");
});

test("two runs of the same model write the same bytes", async () => {
  const model = site([page("/b/", { markdown: "# B" }), page("/a/", { markdown: "# A" })]);
  const first = await run(model);
  const second = await run(model);
  assert.deepEqual(
    first.map((f) => f.path),
    ["a/index.json", "b/index.json"],
  );
  assert.deepEqual(
    first.map((f) => f.contents),
    second.map((f) => f.contents),
  );
});
