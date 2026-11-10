import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { contextPack, slugOf } from "../src/outputs/context-pack.ts";
import { estimateTokens } from "../src/packs/tokens.ts";

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Mizzen",
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

interface PageOptions {
  readonly title?: string;
  readonly source?: string;
}

function page(url: string, markdown: string, options: PageOptions = {}): Page {
  const source = options.source ?? "guide/page.md";
  return {
    url,
    source: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: options.title ?? "Page",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}, overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: { renderPage: () => Promise.resolve(""), report: (diagnostic) => void diagnostics.push(diagnostic) },
  };
}

const INSTALL = `# Install the engine

Install the engine before you configure the site. Install once per machine.

## Requirements

You need Node 24 or newer and a terminal to install.

## Steps

Run the installer and follow the prompts to install.

## Troubleshooting

If the installer fails, read the log.
`;

const DEPLOY = `# Deploy the site

Deploy the built site behind a proxy.

## Build

Run the build and deploy the output folder.

## Rollback

Restore the previous release if a deploy fails.
`;

const COLORS = `# Colors

A page about the color palette.

## Tokens

Each color has a light and a dark value.
`;

function installSite(overrides: Partial<SiteConfig> = {}): Site {
  return site(
    [
      page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
      page("/guide/deploy/", DEPLOY, { title: "Deploy the site", source: "guide/deploy.md" }),
      page("/colors/", COLORS, { title: "Colors", source: "colors.md" }),
    ],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
    overrides,
  );
}

test("a topic writes pack/<slug>.md with a header, URL, source, and the page Markdown", async () => {
  const { ctx, diagnostics } = context();
  const files = await contextPack.run(installSite(), ctx);

  assert.deepEqual(diagnostics, []);
  assert.equal(files.length, 1);
  const pack = files[0]!;
  assert.equal(pack.path, "pack/install.md");
  const contents = String(pack.contents);
  assert.match(contents, /^# Context pack: Install\n\n## Install the engine\n/);
  assert.match(contents, /\n- URL: \/guide\/install\/\n/);
  assert.match(contents, /\n- Source: `guide\/install\.md`\n/);
  assert.match(contents, /Install the engine before you configure the site\./);
  assert.match(contents, /## Requirements\n\nYou need Node 24/);
  // The page's own `# Title` is dropped: the section header already names it.
  assert.doesNotMatch(contents, /^# Install the engine$/m);
  assert.doesNotMatch(contents, /Deploy the built site/);
});

test("the pack stays within the budget and drops trailing sections first", async () => {
  const budget = 80;
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget }] },
  );
  const { ctx, diagnostics } = context();
  const [pack] = await contextPack.run(model, ctx);
  const contents = String(pack?.contents ?? "");

  assert.ok(estimateTokens(contents).tokens <= budget, `pack is ${estimateTokens(contents).tokens} tokens, budget ${budget}`);
  assert.match(contents, /## Requirements/);
  assert.doesNotMatch(contents, /## Troubleshooting/);
  assert.doesNotMatch(contents, /If the installer fails/);
  assert.deepEqual(diagnostics, []);
});

test("pages follow the ranking order, not the model order", async () => {
  const model = site(
    [
      page("/a-colors/", `${COLORS}\n## Install\n\nA short install note for the palette.\n`, {
        title: "Colors",
        source: "colors.md",
      }),
      page("/z-install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
    ],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const { ctx } = context();
  const [pack] = await contextPack.run(model, ctx);
  const contents = String(pack?.contents ?? "");

  const install = contents.indexOf("## Install the engine");
  const colors = contents.indexOf("## Colors");
  assert.ok(install !== -1 && colors !== -1);
  assert.ok(install < colors, "the title match ranks before the body match");
});

test("slugs are lower-case, ASCII, hyphenated, and never contain ..", async () => {
  assert.equal(slugOf("Install & Setup!"), "install-setup");
  assert.equal(slugOf("../../C++ / Guide"), "c-guide");
  assert.equal(slugOf("فارسی"), "");
  assert.ok(!slugOf("../..").includes(".."));

  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    {
      contextPacks: [
        { topic: "Install & Setup!", budget: 20_000 },
        { topic: "../..", query: "install", budget: 20_000 },
        { topic: "Install?", budget: 20_000 },
        { topic: "Install!", budget: 20_000 },
      ],
    },
  );
  const { ctx } = context();
  const files = await contextPack.run(model, ctx);
  assert.deepEqual(
    files.map((file) => file.path),
    ["pack/install-2.md", "pack/install-setup.md", "pack/install.md", "pack/topic-2.md"],
  );
});

test("the URL is absolute when the config has one and site-relative otherwise", async () => {
  const pages = [
    page("/docs/guide/install/", INSTALL, { title: "Install the engine", source: "docs/guide/install.md" }),
  ];
  const topics = { contextPacks: [{ topic: "Install", budget: 20_000 }] };

  const absolute = await contextPack.run(
    site(pages, topics, { base: "/docs", url: "https://example.com" }),
    context().ctx,
  );
  assert.match(String(absolute[0]?.contents), /\n- URL: https:\/\/example\.com\/docs\/guide\/install\/\n/);

  const relative = await contextPack.run(site(pages, topics, { base: "/docs" }), context().ctx);
  assert.match(String(relative[0]?.contents), /\n- URL: \/docs\/guide\/install\/\n/);
});

test("no topics writes no files", async () => {
  const { ctx, diagnostics } = context();
  assert.deepEqual(await contextPack.run(site([page("/colors/", COLORS, { title: "Colors" })]), ctx), []);
  assert.deepEqual(diagnostics, []);

  const empty = site([page("/colors/", COLORS, { title: "Colors" })], { contextPacks: [] });
  assert.deepEqual(await contextPack.run(empty, context().ctx), []);
});

test("a topic with no matching pages is reported instead of writing an empty pack", async () => {
  const { ctx, diagnostics } = context();
  const model = site(
    [page("/colors/", COLORS, { title: "Colors", source: "colors.md" })],
    { contextPacks: [{ topic: "Install", query: "quantum", budget: 20_000 }] },
  );
  const files = await contextPack.run(model, ctx);

  assert.deepEqual(files, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "context-pack.no-pages");
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.match(diagnostics[0]?.message ?? "", /Context pack "Install" has no pages/);
});

test("`pages` restricts the candidates to the named URLs and source paths", async () => {
  const { ctx } = context();
  const model = site(
    [
      page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
      page("/guide/deploy/", DEPLOY, { title: "Deploy the site", source: "guide/deploy.md" }),
    ],
    { contextPacks: [{ topic: "Release", query: "install", pages: ["guide/deploy.md"], budget: 20_000 }] },
  );
  const [pack] = await contextPack.run(model, ctx);
  const contents = String(pack?.contents ?? "");

  assert.match(contents, /## Deploy the site/);
  assert.doesNotMatch(contents, /## Install the engine/);
});

test("a mandatory lead larger than the budget is kept, over budget, and reported", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const { ctx, diagnostics } = context();
  const [pack] = await contextPack.run(model, ctx);
  const contents = String(pack?.contents ?? "");

  assert.ok(estimateTokens(contents).tokens > 1);
  assert.match(contents, /Install the engine before you configure the site/);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.id === "pack.trim.over-budget"));
  assert.equal(diagnostics.find((diagnostic) => diagnostic.id === "pack.trim.over-budget")?.pos?.file, "guide/install.md");
});

test("malformed data is a warning, not a build failure", async () => {
  const { ctx, diagnostics } = context();
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { "context-packs": "Install" },
  );

  assert.deepEqual(await contextPack.run(model, ctx), []);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), ["context-pack.invalid-data"]);
});

test("the same site gives the same bytes whatever the topic order", async () => {
  const first = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
     page("/guide/deploy/", DEPLOY, { title: "Deploy the site", source: "guide/deploy.md" })],
    { contextPacks: [{ topic: "Install", budget: 20_000 }, { topic: "Deploy", budget: 20_000 }] },
  );
  const second = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
     page("/guide/deploy/", DEPLOY, { title: "Deploy the site", source: "guide/deploy.md" })],
    { contextPacks: [{ topic: "Deploy", budget: 20_000 }, { topic: "Install", budget: 20_000 }] },
  );

  const once = await contextPack.run(first, context().ctx);
  const twice = await contextPack.run(first, context().ctx);
  const reversed = await contextPack.run(second, context().ctx);

  assert.deepEqual(twice, once);
  assert.deepEqual(reversed, once);
});
