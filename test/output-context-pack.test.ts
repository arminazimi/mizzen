import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { version } from "../src/index.ts";
import { buildHashOf, hashOf } from "../src/outputs/build-hash.ts";
import { contextPack, slugOf, type PackEvidence } from "../src/outputs/context-pack.ts";
import { estimateTokens } from "../src/packs/tokens.ts";
import { parseSpan } from "../src/source/spans.ts";

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
  readonly lang?: string;
  readonly dir?: "ltr" | "rtl";
}

function page(url: string, markdown: string, options: PageOptions = {}): Page {
  const source = options.source ?? "guide/page.md";
  return {
    url,
    source: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: options.title ?? "Page",
    lang: options.lang ?? "en",
    dir: options.dir ?? "ltr",
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

/** The Markdown pack among the files. */
function markdownOf(files: readonly OutputFile[]): string {
  const found = files.filter((file) => file.path.endsWith(".md"));
  assert.equal(found.length, 1, "one Markdown pack");
  return String(found[0]!.contents);
}

/** The structured twin of the pack, parsed. */
function evidenceOf(files: readonly OutputFile[]): PackEvidence {
  const found = files.filter((file) => file.path.endsWith(".json"));
  assert.equal(found.length, 1, "one structured pack");
  return JSON.parse(String(found[0]!.contents)) as PackEvidence;
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
  assert.deepEqual(
    files.map((file) => file.path),
    ["pack/install.json", "pack/install.md"],
  );
  const contents = markdownOf(files);
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
  const contents = markdownOf(await contextPack.run(model, ctx));

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
  const contents = markdownOf(await contextPack.run(model, ctx));

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
    [
      "pack/install-2.json",
      "pack/install-2.md",
      "pack/install-setup.json",
      "pack/install-setup.md",
      "pack/install.json",
      "pack/install.md",
      "pack/topic-2.json",
      "pack/topic-2.md",
    ],
  );
});

test("moving a page changes the build identity even when its content is unchanged", async () => {
  const topics = { contextPacks: [{ topic: "Install", budget: 20_000 }] };
  const before = evidenceOf(
    await contextPack.run(site([page("/guide/install/", INSTALL)], topics), context().ctx),
  );
  const after = evidenceOf(
    await contextPack.run(site([page("/guide/setup/", INSTALL)], topics), context().ctx),
  );

  assert.notEqual(after.build.id, before.build.id, "the full page URL is part of the build identity");
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
  assert.match(markdownOf(absolute), /\n- URL: https:\/\/example\.com\/docs\/guide\/install\/\n/);

  const relative = await contextPack.run(site(pages, topics, { base: "/docs" }), context().ctx);
  assert.match(markdownOf(relative), /\n- URL: \/docs\/guide\/install\/\n/);
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
  const contents = markdownOf(await contextPack.run(model, ctx));

  assert.match(contents, /## Deploy the site/);
  assert.doesNotMatch(contents, /## Install the engine/);
});

test("a mandatory lead larger than the budget is kept, over budget, and reported", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const { ctx, diagnostics } = context();
  const contents = markdownOf(await contextPack.run(model, ctx));

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

test("the structured twin traces every selected page to its source, span, locale, and build", async () => {
  const model = installSite();
  const files = await contextPack.run(model, context().ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);

  assert.equal(evidence.version, 1);
  assert.deepEqual(evidence.topic, { name: "Install", query: "Install", budget: 20_000 });
  assert.equal(evidence.build.engine, version);
  assert.equal(
    evidence.build.id,
    buildHashOf(
      Object.fromEntries(
        model.pages.map((entry) => [
          entry.url.replace(/^\/+|\/+$/g, "") || "index",
          hashOf(`${entry.url}\0${hashOf(entry.markdown)}`),
        ]),
      ),
    ),
    "the build identity is build-hash.ts's rule over relative page URLs and their full URLs",
  );
  assert.equal(evidence.build.id, evidence.items[0]?.build);

  const install = evidence.items[0]!;
  assert.equal(install.id, "/guide/install/");
  assert.equal(install.url, "/guide/install/");
  assert.equal(install.title, "Install the engine");
  assert.deepEqual(install.origin, { source: "guide/install.md", span: "guide/install.md:1:1-1:1" });
  assert.equal(install.version, null);
  assert.deepEqual(install.locale, { lang: "en", dir: "ltr" });
  assert.equal(install.hash, hashOf(INSTALL));

  // Both representations describe the same evidence.
  assert.ok(markdown.includes(`- Source: \`${install.origin.source}\``));
  assert.ok(markdown.includes(install.content));

  assert.deepEqual(
    install.sections.map((section) => section.text),
    ["Requirements", "Steps", "Troubleshooting"],
  );
  for (const section of install.sections) {
    assert.equal(section.id, section.span.slice(0, section.span.lastIndexOf("-")), "the id is the span's start");
    assert.equal(parseSpan(section.span)?.file, "guide/install.md");
  }
});

test("a versioned, localized page records its version folder and locale", async () => {
  const model = site(
    [page("/v2/guide/install/", INSTALL, {
      title: "Install the engine",
      source: "v2/guide/install.md",
      lang: "fa",
      dir: "rtl",
    })],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const [item] = evidenceOf(await contextPack.run(model, context().ctx)).items;

  assert.equal(item?.version, "v2");
  assert.deepEqual(item?.locale, { lang: "fa", dir: "rtl" });
});

test("every item carries the page's trust reasons from the site's data", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    {
      contextPacks: [{ topic: "Install", budget: 20_000 }],
      examples: { "/guide/install/": { total: 2, passed: 2, failed: 0 } },
      drift: { "/guide/install/": 0 },
    },
  );
  const [item] = evidenceOf(await contextPack.run(model, context().ctx)).items;

  assert.equal(item?.trust?.level, "review-due", "no review source means the age is unknown, never verified");
  assert.deepEqual(item?.trust?.evidence, { examples: "measured", drift: "measured", review: "missing" });
  assert.deepEqual(item?.trust?.reasons.map((reason) => reason.code), ["examples.passed", "drift.clean", "review.unknown"]);
});

test("neither twin leaks an absolute path or an unselected page", async () => {
  const model = installSite();
  const files = await contextPack.run(model, context().ctx);
  const text = files.map((file) => String(file.contents)).join("\n");

  assert.equal(text.includes(process.cwd()), false);
  assert.equal(text.includes("/colors/"), false, "a page the query did not select stays out");
  for (const item of evidenceOf(files).items) {
    assert.equal(item.origin.source.startsWith("/"), false);
    assert.equal(/^[A-Za-z]:/.test(item.origin.source), false);
    assert.equal(item.origin.span.startsWith(`${item.origin.source}:`), true);
  }
});

test("a Windows source path is written with forward slashes", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide\\install.md" })],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const [item] = evidenceOf(await contextPack.run(model, context().ctx)).items;

  assert.equal(item?.origin.source, "guide/install.md");
  assert.equal(item?.origin.span.startsWith("guide/install.md:"), true);
  for (const section of item?.sections ?? []) {
    assert.equal(section.span.startsWith("guide/install.md:"), true);
    assert.equal(section.id.startsWith("guide/install.md:"), true);
  }
});
