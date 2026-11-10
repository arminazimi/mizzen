import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { NavTree, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { llms } from "../src/outputs/llms.ts";

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

function page(url: string, kind: Page["kind"] = "doc", description?: string): Page {
  return {
    url,
    source: pos,
    frontMatter: description === undefined ? {} : { description },
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind,
  };
}

function site(pages: readonly Page[], nav: NavTree, overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav, data: {} };
}

/** The render host is not read by the llms output, so it answers nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.resolve(""),
  report: () => {},
};

async function run(model: Site): Promise<string> {
  const [file] = await llms.run(model, ctx);
  assert.ok(file, "llms writes one file");
  assert.equal(file.path, "llms.txt");
  assert.equal(typeof file.contents, "string");
  return file.contents as string;
}

/**
 * The llmstxt.org rules, as a check: one H1 title on the first line; an optional blockquote summary before the first
 * section; H2 sections holding only lists of `- [title](url)` links with an optional `: notes`; every link naming a
 * Markdown twin; no link repeated; and a single final newline.
 */
function assertLlmsTxtFormat(text: string): void {
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "one final newline");
  const lines = text.split("\n").slice(0, -1);
  assert.match(lines[0] ?? "", /^# \S.*$/, "the first line is the H1 title");
  assert.equal(lines.filter((l) => /^# /.test(l)).length, 1, "exactly one H1");

  let inSection = false;
  const hrefs = new Set<string>();
  lines.slice(1).forEach((line, i) => {
    const where = `line ${i + 2}: ${line}`;
    if (line === "") return;
    if (line.startsWith("> ")) {
      assert.equal(inSection, false, `the summary comes before the first section, ${where}`);
      return;
    }
    if (line.startsWith("## ")) {
      assert.match(line, /^## \S.*$/, where);
      inSection = true;
      return;
    }
    assert.ok(inSection, `a link sits under a section, ${where}`);
    const link = /^- \[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)(: .+)?$/.exec(line);
    assert.ok(link, `a section holds only links, ${where}`);
    const href = link[2]!;
    const path = href.replace(/^https?:\/\/[^/]+/, "");
    assert.ok(path.endsWith(".md"), `a link names a Markdown twin, ${where}`);
    assert.ok(!hrefs.has(href), `no link repeats, ${where}`);
    hrefs.add(href);
  });
}

test("fixtures/docs-site: llms.txt follows the format rules, sections follow the navigation groups, and links name the twins", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const text = await run(model);

  assertLlmsTxtFormat(text);
  assert.ok(text.startsWith(`# ${model.config.title}\n`), text.slice(0, 200));

  const headings = text.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headings.slice(0, 3), ["## Pages", "## Guide", "## Operations"], headings.join(" | "));

  assert.match(text, /^- \[Home\]\(\/index\.md\)$/m);
  assert.match(text, /^- \[Install\]\(\/install\/index\.md\)/m);
  assert.match(text, /^- \[Reference\]\(\/reference\/index\.md\)$/m);
  assert.doesNotMatch(text, /dashboard/i, "app pages appear in no llms file");

  const docs = new Set(model.pages.filter((p) => p.kind === "doc").map((p) => p.url));
  const hrefs = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
  assert.ok(hrefs.length >= 6, `got ${hrefs.length} links`);
  for (const path of hrefs) {
    assert.ok(path.endsWith("/index.md"), path);
    assert.ok(docs.has(path.slice(0, -"index.md".length)), `${path} twins a doc page`);
  }

  assert.equal(await run(model), text, "the same model gives the same file");
});

test("the description is the summary, and each link carries its page's description", async () => {
  const model = site(
    [page("/", "doc", "  Start\n  here. "), page("/guide/install/", "doc", "Install it.")],
    { main: [{ title: "Home", url: "/" }, { title: "Install", url: "/guide/install/" }] },
    { description: "A  site\nfor agents." },
  );
  assert.equal(
    await run(model),
    [
      "# Slipway",
      "",
      "> A site for agents.",
      "",
      "## Pages",
      "",
      "- [Home](/index.md): Start here.",
      "- [Install](/guide/install/index.md): Install it.",
      "",
    ].join("\n"),
  );
});

test("sections follow the navigation groups, in order, and a page listed twice is listed once", async () => {
  const model = site(
    [page("/guide/install/"), page("/guide/old.html"), page("/", "doc")],
    {
      main: [
        { title: "Home", url: "/" },
        { title: "Guide", children: [{ title: "Install", url: "/guide/install/" }, { title: "Old", url: "/guide/old.html" }] },
        { title: "Again", children: [{ title: "Home", url: "/" }] },
      ],
    },
  );
  const text = await run(model);
  assert.equal(
    text,
    [
      "# Slipway",
      "",
      "## Pages",
      "",
      "- [Home](/index.md)",
      "",
      "## Guide",
      "",
      "- [Install](/guide/install/index.md)",
      "- [Old](/guide/old.md)",
      "",
    ].join("\n"),
  );
  assertLlmsTxtFormat(text);
});

test("external links, links to missing pages, app pages, and files without a twin are left out", async () => {
  const model = site(
    [page("/guide/install/"), page("/dashboard/", "app"), page("/feed.xml")],
    {
      main: [
        {
          title: "Guide",
          children: [
            { title: "External", url: "https://other.example/" },
            { title: "Missing", url: "/nope/" },
            { title: "Dashboard", url: "/dashboard/" },
            { title: "Feed", url: "/feed.xml" },
            { title: "Install", url: "/guide/install/" },
          ],
        },
      ],
    },
  );
  assert.equal(await run(model), "# Slipway\n\n## Guide\n\n- [Install](/guide/install/index.md)\n");
});

test("link text is escaped, and a description keeps no line break", async () => {
  const model = site(
    [page("/a/", "doc", "Line one\nline two")],
    { main: [{ title: "Use [brackets] and \\", url: "/a/" }] },
  );
  const text = await run(model);
  assert.ok(text.includes("- [Use \\[brackets\\] and \\\\](/a/index.md): Line one line two\n"), text);
  assertLlmsTxtFormat(text);
});

test("a site without a url links with paths that include base, and an empty navigation keeps the title and summary", async () => {
  const model = site(
    [page("/docs/guide/", "doc")],
    { main: [{ title: "Guide", url: "/docs/guide/" }] },
    { base: "/docs", title: "Docs", description: "Summary." },
  );
  assert.equal(await run(model), "# Docs\n\n> Summary.\n\n## Pages\n\n- [Guide](/docs/guide/index.md)\n");
  assert.equal(await run(site([], {})), "# Slipway\n");
});
