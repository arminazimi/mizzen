import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { NavTree, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { llmsFull } from "../src/outputs/llms-full.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Slipway",
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

function page(
  url: string,
  title = url,
  markdown = "",
  kind: Page["kind"] = "doc",
  frontMatter: Page["frontMatter"] = {},
): Page {
  return {
    url,
    source: pos,
    frontMatter,
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind,
  };
}

function site(pages: readonly Page[], nav: NavTree, overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav, data: {} };
}

/** The render host is not read by the llms-full output, so it answers nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.resolve(""),
  report: () => {},
};

async function run(model: Site): Promise<string> {
  const [file] = await llmsFull.run(model, ctx);
  assert.ok(file, "llms-full writes one file");
  assert.equal(file.path, "llms-full.txt");
  assert.equal(typeof file.contents, "string");
  return file.contents as string;
}

/** Every page header's URL, in the order the file writes them. */
function sources(text: string): string[] {
  return [...text.matchAll(/^Source: (.*)$/gm)].map((match) => match[1]!);
}

/** A page body as the output writes it: LF line endings, no blank first or last line. */
function body(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

test("fixtures/docs-site: every doc page appears once, in navigation order, and the app page appears nowhere", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const text = await run(model);

  assert.ok(text.startsWith(`# ${model.config.title}\n`), text.slice(0, 200));
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "one final newline");

  const docs = model.pages.filter((p) => p.kind === "doc");
  const urls = sources(text);
  assert.equal(urls.length, docs.length, "one header per doc page");
  assert.equal(new Set(urls).size, urls.length, "no page appears twice");
  assert.deepEqual(new Set(urls), new Set(docs.map((p) => p.url)));

  const at = (url: string): number => urls.indexOf(url);
  assert.ok(at("/") < at("/install/"), "the navigation's first page comes first");
  assert.ok(at("/faq/") < at("/reference/"), "the Reference section follows the Operations group");
  assert.ok(at("/reference/") < at("/reference/build/"), "a section's own page comes before its pages");
  assert.ok(at("/reference/build/") < at("/rules/"), "the Reference section comes before Rules");
  assert.ok(at("/rules/") < at("/rules/artifacts-001/"), "a section's pages follow its page");
  assert.ok(at("/rules/targets-053/") < at("/features/"), "the large Rules section comes before Features");
  assert.equal(urls.at(-1), "/404.html", "a page the navigation does not list comes last, by URL");

  assert.ok(!urls.some((url) => url === "/dashboard/" || url.startsWith("/dashboard/")), "no app page");
  assert.ok(!text.includes("dashboard/index.html"), "the app page's files are not quoted");

  const install = docs.find((p) => p.url === "/install/");
  assert.ok(install, "the fixture has the install page");
  assert.ok(text.includes(`# ${install.title}\n\nSource: /install/\n\n${body(install.markdown)}`), "the source Markdown follows the header");
  assert.ok(!text.includes("title: Install Beacon"), "front matter is not included");
  assert.ok(text.includes("::::tabs"), "directives stay in their readable source form");

  assert.equal(await run(model), text, "the same model gives the same file");
});

test("the file starts with the site title and summary, then one titled header per page with its absolute URL", async () => {
  const model = site(
    [
      page("/", "Home", "\n# Beacon\n\nWelcome.\n"),
      page(
        "/guide/install/",
        "Install",
        "# Install\r\n\r\n:::callout{type=warning}\r\nCareful.\r\n:::\r\n",
      ),
    ],
    { main: [{ title: "Home", url: "/" }, { title: "Install", url: "/guide/install/" }] },
    { title: "Beacon", description: "A  site\nfor agents.", url: "https://example.com/" },
  );

  assert.equal(
    await run(model),
    [
      "# Beacon",
      "",
      "> A site for agents.",
      "",
      "---",
      "",
      "# Home",
      "",
      "Source: https://example.com/",
      "",
      "# Beacon",
      "",
      "Welcome.",
      "",
      "---",
      "",
      "# Install",
      "",
      "Source: https://example.com/guide/install/",
      "",
      "# Install",
      "",
      ":::callout{type=warning}",
      "Careful.",
      ":::",
      "",
    ].join("\n"),
  );
});

test("reading order: navigation leaves, a section's match pages where it sits, once each, then the unlisted pages by URL", async () => {
  const model = site(
    [
      page("/unlisted/"),
      page("/rules/two/"),
      page("/reference/z/"),
      page("/b/"),
      page("/reference/build/"),
      page("/rules/one/"),
      page("/rules/"),
      page("/reference/"),
      page("/a/"),
      page("/"),
      page("/c/"),
      page("/dashboard/", "Dashboard", "", "app"),
      page("/dashboard/inner/"),
    ],
    {
      main: [
        { title: "Home", url: "/" },
        { title: "A", url: "/a/" },
        { title: "Reference", url: "/reference/", match: "/reference/" },
        { title: "Rules", url: "/rules/", match: "/rules/" },
        { title: "Missing", url: "/missing/" },
        { title: "External", url: "https://other.example/" },
        { title: "Dashboard", url: "/dashboard/" },
        { title: "B", url: "/b/" },
        { title: "Again", children: [{ title: "A again", url: "/a/" }] },
      ],
    },
  );

  assert.deepEqual(sources(await run(model)), [
    "/",
    "/a/",
    "/reference/",
    "/reference/build/",
    "/reference/z/",
    "/rules/",
    "/rules/one/",
    "/rules/two/",
    "/b/",
    "/c/",
    "/unlisted/",
  ]);
});

test("without a site url the address is site-relative and keeps base, and a blank page is header only", async () => {
  const model = site([page("/docs/guide/", "Guide")], { main: [{ title: "Guide", url: "/docs/guide/" }] }, {
    title: "Docs",
    base: "/docs",
  });
  assert.equal(
    await run(model),
    [
      "# Docs",
      "",
      "---",
      "",
      "# Guide",
      "",
      "Source: /docs/guide/",
      "",
    ].join("\n"),
  );

  assert.equal(sources(await run(model)).length, 1, "the empty body adds no text");
});

test("with no main list the reading order follows docs, and a site with no pages is the title alone", async () => {
  const model = site(
    [page("/b/"), page("/a/")],
    { docs: [{ title: "A", url: "/a/" }, { title: "B", url: "/b/" }] },
    { title: "Docs", base: "/docs" },
  );
  assert.deepEqual(sources(await run(model)), ["/a/", "/b/"]);

  assert.equal(await run(site([], {})), "# Slipway\n");
  assert.equal(await run(site([], {}, { title: "Docs", description: "A  summary.\n" })), "# Docs\n\n> A summary.\n");
});

test("the output is named llms-full", () => {
  assert.equal(llmsFull.name, "llms-full");
});
