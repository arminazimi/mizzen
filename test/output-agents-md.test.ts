import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../src/config/load.ts";
import type { Diagnostic, Page, Site } from "../src/contracts/index.ts";
import { agentsMd } from "../src/outputs/agents-md.ts";
import { buildModel } from "../src/model/build.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function site(overrides: Partial<Site["config"]> = {}, pages: readonly Page[] = [], nav: Site["nav"] = {}): Site {
  return {
    config: {
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
    },
    pages,
    nav,
    data: {},
  };
}

function page(url: string, file = "guide/install.md", kind: Page["kind"] = "doc"): Page {
  return {
    url,
    source: { ...pos, file },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind,
  };
}

async function run(
  model: Site,
  report: (diagnostic: Diagnostic) => void = () => {},
): Promise<readonly { path: string; contents: string | Uint8Array }[]> {
  return agentsMd.run(model, { renderPage: async () => "", report });
}

/** The page with an `agent` block as the front-matter loader would hand it over. */
function withAgent(base: Page, agent: unknown): Page {
  return { ...base, frontMatter: { agent: agent as NonNullable<Page["frontMatter"]["agent"]> } };
}

/** The text of the one file the output writes. */
async function textOf(model: Site, report?: (diagnostic: Diagnostic) => void): Promise<string> {
  return String((await run(model, report))[0]?.contents);
}

test("the output is named after its file", () => {
  assert.equal(agentsMd.name, "agents-md");
});

test("fixtures/docs-site writes one AGENTS.md at the output root, built from its config and model", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const files = await run(model);

  assert.deepEqual(files.map((f) => f.path), ["AGENTS.md"]);
  const text = String(files[0]?.contents);
  assert.ok(text.startsWith("# AGENTS.md\n"), "the file starts with its heading");
  assert.ok(text.includes(`**${model.config.title}**`), "the site title comes from the model's config");
  assert.ok(text.includes(`- Title: ${model.config.title}`), "the title line comes from the model's config");
  assert.ok(text.includes(`\`${CONFIG_FILE}\``), "the config file name comes from the engine");
  assert.ok(text.includes("`docs`"), "the navigation list names come from the model");
  assert.ok(text.includes("`/guide/install/`"), "the example URL follows the pretty URL rule");
  const docs = model.pages.filter((p) => p.kind === "doc").length;
  const apps = model.pages.filter((p) => p.kind === "app").length;
  assert.ok(text.includes(`${docs} rendered from Markdown or HTML, and ${apps} app page`), "page counts come from the model");
  assert.ok(text.includes("## How to add a page"));
  assert.ok(text.includes("## How to check a change"));
  assert.ok(text.includes("## Generated files"));
});

test("two builds of the same site write the same bytes", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const first = await run((await buildModel(root)).site);
  const second = await run((await buildModel(root)).site);
  assert.deepEqual(first, second);
});

test("the base path and the repository show up in the file, and an empty base says so", async () => {
  const withBase = await run(
    site({ base: "/evergreen", repository: { url: "https://github.com/example/docs", branch: "trunk", dir: "site" } }),
  );
  const text = String(withBase[0]?.contents);
  assert.ok(text.includes("- Base path: `/evergreen`"));
  assert.ok(text.includes("`/evergreen/guide/new-page/`"));
  assert.ok(text.includes("https://github.com/example/docs, branch `trunk`, folder `site`"));

  const bare = String(((await run(site()))[0])?.contents);
  assert.ok(bare.includes("- Base path: none, the site is at the domain root"));
  assert.ok(bare.includes("- Edit links: none; no repository is set."));
  assert.ok(bare.includes("- URL: not set"));
  assert.ok(bare.includes("- Languages: only the default language"));
});

test("languages are listed in switcher order with their prefixes", async () => {
  const text = String(
    ((await run(
      site({
        languages: [
          { code: "en", name: "English", prefix: "" },
          { code: "fa", name: "Persian", prefix: "/fa" },
        ],
      }),
    ))[0])?.contents,
  );
  assert.ok(text.includes("- Languages, in switcher order:"));
  assert.ok(text.includes("  - English (`en`): the default language, no URL prefix"));
  assert.ok(text.includes("  - Persian (`fa`): URL prefix `/fa`"));
});

test("a site's own AGENTS.md in the source wins, so nothing is written", async () => {
  assert.deepEqual(await run(site({}, [page("/AGENTS/", "AGENTS.md")])), []);
});

test("the source folder decides where the site's own AGENTS.md lives", async () => {
  const owned = site({ source: "docs" }, [page("/AGENTS/", "docs/AGENTS.md")]);
  assert.deepEqual(await run(owned), []);

  const other = site({ source: "docs" }, [page("/guide/install/", "docs/guide/install.md")]);
  assert.equal((await run(other)).length, 1);
});

test("a page whose permalink is the site's /AGENTS.md wins as well, under the base", async () => {
  assert.deepEqual(await run(site({ base: "/evergreen" }, [page("/evergreen/AGENTS.md", "notes.md")])), []);
  assert.equal((await run(site({ base: "/evergreen" }, [page("/evergreen/AGENTS/", "AGENTS-old.md")]))).length, 1);
});

/** The exact bytes a site without page rules wrote before the `Page rules` section existed. */
const GOLDEN = [
  "# AGENTS.md",
  "",
  "Instructions for coding agents that work on the site **Example**. This file is written by the build from the site's config and content, so it describes this build. Read it before every task.",
  "",
  "## Site",
  "",
  "- Title: Example",
  "- Description: none",
  "- URL: not set; canonical links and the sitemap are left out",
  "- Base path: none, the site is at the domain root",
  "- Default language: `en`, direction `ltr`",
  "- Languages: only the default language",
  "",
  "## Where content lives",
  "",
  "- Config: `mizzen.yml` at the site root. Every path in it is relative to the site root.",
  "- Source folder: the site root.",
  "- Navigation: `_data/navigation.yml`. Navigation lists in this build: none; the docs list is built from the folders.",
  "- Data files (`_data/`): none.",
  "- Edit links: none; no repository is set.",
  "- Pages in this build: 1 rendered from Markdown or HTML, and 0 app pages copied as they are.",
  "",
  "## Pages",
  "",
  "- Each Markdown file (`.md`, `.markdown`) under the source folder is a page. An HTML file is a page only when it starts with front matter.",
  "- A page's URL follows its path: `guide/install.md` is served at `/guide/install/`. `index.md` and `README.md` are served at their folder's URL.",
  "- Front matter `permalink` sets another URL. A URL that names a file, such as `/404.html`, is written as that file.",
  "- Folders whose name starts with `_` are skipped, except `_data`. Names that start with `.` are skipped.",
  "- A folder whose `index.html` has no front matter is an app page: every file in it is copied as it is.",
  "- Front matter keys the engine reads: `title`, `description`, `permalink`, `redirect_from`, `redirect_to`, `lang`, `dir`, `order`, `status`, `agent`, `search`, `published`, `image`, and `translation_key`. Other keys are kept for rendering.",
  "- A folder named after a language's URL prefix (for example `fa/` for the prefix `/fa`) holds that language's pages.",
  "",
  "## How to add a page",
  "",
  "1. Create `<folder>/<page>.md`. The file name sets the page's address.",
  "2. Start the file with front matter and write plain Markdown after it:",
  "",
  "```markdown",
  "---",
  "title: New page",
  "description: One sentence about the page.",
  "---",
  "",
  "Plain Markdown here.",
  "```",
  "",
  "3. To list the page in navigation, add an item with `title` and `url` to the `docs` list (the sidebar) or the `main` list (the header) in `_data/navigation.yml`. `url` is the page's address, such as `/guide/new-page/`. If that file has no lists, the sidebar is built from the folders instead, ordered by `order` and then by title.",
  "4. Build the site and check the change (see below).",
  "",
  "## How to check a change",
  "",
  "1. Build the site.",
  "2. Check the source and the build: `npx mizzen doctor . --build <build folder>`.",
  "3. Read every finding. Each one names a file and often a line. Fix it in the source, build again, and repeat until the check is clean.",
  "",
  "## Generated files",
  "",
  "- Everything the build writes to the build folder is generated: a rendered `index.html` for each page, the copied files, and this `AGENTS.md`. Edit the source, never the build folder.",
  "- An output can be turned off in the config's `outputs` map by its name. `outputs:` with `agents-md: false` removes only this file.",
  "",
  "## Never",
  "",
  "- Never edit the build folder; the next build replaces it.",
  "- Never invent front matter keys or config keys; use only the ones listed here or in the schema of the config.",
  "- Never change `translation_key` on one translation only; change every page that shares it, or none.",
  "- Never rename a page's file to change its title; set `title`, because the file name is the page's address.",
  "",
].join("\n");

test("without page rules the file is byte for byte the file it was before", async () => {
  assert.equal(await textOf(site({}, [page("/guide/install/")])), GOLDEN);
});

test("a page with notes but no rules adds nothing", async () => {
  const model = site({}, [withAgent(page("/guide/install/"), { notes: "Change the constant, not the page." })]);
  assert.equal(await textOf(model), GOLDEN);
});

test("an empty rules list adds nothing", async () => {
  const model = site({}, [withAgent(page("/guide/install/"), { rules: [] })]);
  assert.equal(await textOf(model), GOLDEN);
});

test("page rules become one section, sorted by page URL and then by rule", async () => {
  const model = site({}, [
    withAgent(page("/guide/", "guide/index.md"), {
      rules: ["Update the screenshots", "Never change the version table by hand"],
    }),
    withAgent(page("/api/", "api/index.md"), { rules: ["Regenerate the reference"] }),
    withAgent(page("/guide/install/", "guide/install.md"), {
      rules: ["Run the tests", "Never change the version table by hand"],
    }),
  ]);
  const text = await textOf(model);

  const section = [
    "## Page rules",
    "",
    "Rules the authors wrote for particular pages, from each page's `agent.rules`:",
    "",
    "- /api/ — Regenerate the reference",
    "- /guide/ — Never change the version table by hand",
    "- /guide/ — Update the screenshots",
    "- /guide/install/ — Never change the version table by hand",
    "- /guide/install/ — Run the tests",
    "",
  ].join("\n");
  assert.ok(text.includes(section), "the section lists every page and rule pair in order");
  assert.equal(text.split("## Page rules").length, 2, "the section appears once");
  assert.ok(text.indexOf("## Page rules") > text.indexOf("## Pages"), "the section follows Pages");
  assert.ok(text.indexOf("## Page rules") < text.indexOf("## How to add a page"), "the section precedes the guide");
});

test("a repeated page and rule pair is listed once", async () => {
  const model = site({}, [
    withAgent(page("/guide/install/"), { rules: ["Run the tests", "Run the tests"] }),
  ]);
  const text = await textOf(model);
  assert.equal(text.match(/- \/guide\/install\/ — Run the tests/g)?.length, 1);
});

test("a rule keeps to one line, with backslashes and control characters escaped", async () => {
  const model = site({}, [
    withAgent(page("/guide/install/"), {
      rules: ["CR\rLF", "Keep C:\\docs\\new", "Line one\nLine two", "Tab\there"],
    }),
  ]);
  const text = await textOf(model);
  const section = [
    "## Page rules",
    "",
    "Rules the authors wrote for particular pages, from each page's `agent.rules`:",
    "",
    String.raw`- /guide/install/ — CR\rLF`,
    String.raw`- /guide/install/ — Keep C:\\docs\\new`,
    String.raw`- /guide/install/ — Line one\nLine two`,
    String.raw`- /guide/install/ — Tab\there`,
    "",
  ].join("\n");
  assert.ok(text.includes(section));
});

test("an invalid agent block adds no rules and is reported at the page's file", async () => {
  const reported: Diagnostic[] = [];
  const model = site({}, [
    withAgent(page("/bad/", "bad.md"), "docs-team"),
    withAgent(page("/worse/", "worse.md"), { rules: 5 }),
  ]);
  const text = await textOf(model, (d) => reported.push(d));
  assert.equal(text.includes("## Page rules"), false, "an invalid block adds no section");
  assert.deepEqual(reported.map((d) => d.id), ["agent.not-a-mapping", "agent.invalid-type"]);
  for (const [index, d] of reported.entries()) {
    assert.equal(d.severity, "error");
    assert.deepEqual(d.pos, {
      file: index === 0 ? "bad.md" : "worse.md",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    });
  }
});

test("a non-string rule is reported and the valid rules around it are kept", async () => {
  const reported: Diagnostic[] = [];
  const model = site({}, [withAgent(page("/guide/install/"), { rules: ["Run the tests", 42, "Keep the table sorted"] })]);
  const text = await textOf(model, (d) => reported.push(d));

  assert.ok(text.includes("- /guide/install/ — Keep the table sorted"));
  assert.ok(text.includes("- /guide/install/ — Run the tests"));
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.id, "agent.invalid-type");
  assert.match(reported[0]!.message, /Every entry in `agent\.rules` must be a string/);
  assert.deepEqual(reported[0]!.pos, { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 });
});
