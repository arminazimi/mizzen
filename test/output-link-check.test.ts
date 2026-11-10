import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { checkLinks, linkCheck } from "../src/outputs/link-check.ts";

/** A page's content starts on line 1 unless a test says otherwise. */
function sourcePos(file: string, line = 1) {
  return { file, line, column: 1, endLine: line, endColumn: 1 };
}

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

/** A doc page with its Markdown body and heading ids. */
function page(
  source: string,
  url: string,
  markdown = "",
  headings: readonly string[] = [],
  frontMatter: Page["frontMatter"] = {},
  line = 1,
): Page {
  return {
    url,
    source: sourcePos(source, line),
    frontMatter,
    title: url,
    lang: "en",
    dir: "ltr",
    headings: headings.map(
      (id): Heading => ({ depth: 2, id, text: id, pos: sourcePos(source) }),
    ),
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The ids of the findings, in the order the check returns them. */
function ids(model: Site): string[] {
  return checkLinks(model).map((finding) => finding.id);
}

test("relative links resolve from the source folder and from the page URL, and root links get the base", () => {
  const model = site(
    [
      page("install.md", "/docs/install/"),
      page("guide/install.md", "/docs/guide/install/"),
      page("guide/other.md", "/docs/guide/other/"),
      page(
        "guide/setup.md",
        "/docs/guide/setup/",
        [
          "[up](../install/)",
          "[sibling](./other.md)",
          "[root](/guide/install/)",
          "[based](/docs/guide/install/)",
        ].join("\n"),
      ),
    ],
    { base: "/docs" },
  );
  assert.deepEqual(checkLinks(model), []);
});

test("a link to a missing page is reported with the position of the link", () => {
  const model = site([
    page("guide/setup.md", "/guide/setup/", "Intro.\n\n[gone](../missing/)", [], {}, 4),
  ]);
  assert.deepEqual(checkLinks(model), [
    {
      id: "link.missing-page",
      page: "/guide/setup/",
      href: "../missing/",
      target: "../missing/",
      message: 'The link to "../missing/" names no page or redirect on this site.',
      help: "Fix the link, or add the page or a redirect it names.",
      pos: { file: "guide/setup.md", line: 6, column: 1, endLine: 6, endColumn: 19 },
    },
  ]);
});

test("anchors resolve against the target page's headings and against the page itself", () => {
  const model = site([
    page("install.md", "/install/", "", ["step-2"]),
    page(
      "guide/setup.md",
      "/guide/setup/",
      [
        "[ok](../install.md#step-2)",
        "[bad](../install.md#step-3)",
        "[same](#local)",
        "[gone](#nope)",
      ].join("\n"),
      ["local"],
    ),
  ]);
  assert.deepEqual(
    checkLinks(model).map((finding) => [finding.id, finding.href, finding.target]),
    [
      ["link.missing-anchor", "../install.md#step-3", "/install/"],
      ["link.missing-anchor", "#nope", "/guide/setup/"],
    ],
  );
});

test("anchors with no path are checked against the page they appear on", () => {
  const model = site([page("guide/setup.md", "/guide/setup/", "[a](#intro)", ["intro"])]);
  assert.deepEqual(checkLinks(model), []);
});

test(".md links resolve through the pretty-URL rules, from the source folder and from the site root", () => {
  const model = site(
    [
      page("install.md", "/docs/install/"),
      page("guide/setup.md", "/docs/guide/setup/", "[a](../install.md)\n[b](/install.md)"),
    ],
    { base: "/docs" },
  );
  assert.deepEqual(checkLinks(model), []);
});

test("a config redirect and a redirect_from old path both answer a link", () => {
  const model = site(
    [
      page("install.md", "/docs/install/"),
      page("legacy.md", "/docs/legacy/", "", [], { redirect_from: "/from-old/" }),
      page("guide/setup.md", "/docs/guide/setup/", "[a](/old/)\n[b](/from-old/)\n[c](/nowhere/)"),
    ],
    { base: "/docs", redirects: { "/old/": "/install/" } },
  );
  assert.deepEqual(
    checkLinks(model).map((finding) => [finding.id, finding.href]),
    [["link.missing-page", "/nowhere/"]],
  );
});

test("a page's redirect_to is followed for its anchors", () => {
  const model = site([
    page("install.md", "/install/", "", ["step-2"]),
    page("moved.md", "/moved/", "", [], { redirect_to: "/install/" }),
    page("guide/setup.md", "/guide/setup/", "[ok](/moved/#step-2)\n[bad](/moved/#step-9)"),
  ]);
  assert.deepEqual(
    checkLinks(model).map((finding) => [finding.id, finding.href, finding.target]),
    [["link.missing-anchor", "/moved/#step-9", "/install/"]],
  );
});

test("external schemes, protocol-relative URLs, query-only links, and asset files are not checked", () => {
  const model = site([
    page(
      "guide/setup.md",
      "/guide/setup/",
      [
        "[site](https://example.com/x)",
        "[protocol](//example.com/x)",
        "[mail](mailto:hi@example.com)",
        "[tel](tel:+123)",
        "[query](?page=2)",
        "[asset](image.png)",
        "[pdf](../files/report.pdf)",
        "[empty](#)",
      ].join("\n"),
    ),
  ]);
  assert.deepEqual(checkLinks(model), []);
});

test("a query and a fragment on a page link are split before the page is resolved", () => {
  const model = site([
    page("install.md", "/install/", "", ["step-2"]),
    page(
      "guide/setup.md",
      "/guide/setup/",
      ["[ok](../install.md?page=2#step-2)", "[bad](../install.md?page=2#step-9)"].join("\n"),
    ),
  ]);
  assert.deepEqual(
    checkLinks(model).map((finding) => [finding.id, finding.href]),
    [["link.missing-anchor", "../install.md?page=2#step-9"]],
  );
});

test("reference links are checked through their definitions once", () => {
  const model = site([
    page(
      "guide/setup.md",
      "/guide/setup/",
      ["[a][r] and [b][r].", "", "[r]: ../missing.md", ""].join("\n"),
    ),
  ]);
  const findings = checkLinks(model);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "link.missing-page");
  assert.equal(findings[0]?.pos.line, 3);
});

test("the findings are the same whatever order the pages arrive in", () => {
  const first = page("a.md", "/a/", "[x](/missing-a/)");
  const second = page("b.md", "/b/", "[y](/missing-b/)");
  const one = site([first, second]);
  const other = site([second, first]);

  assert.deepEqual(checkLinks(one), checkLinks(one));
  assert.deepEqual(checkLinks(one), checkLinks(other));
  assert.deepEqual(
    checkLinks(one).map((finding) => finding.target),
    ["/missing-a/", "/missing-b/"],
  );
});

test("the output reports each finding as a warning and writes no file", async () => {
  const model = site([page("guide/setup.md", "/guide/setup/", "[gone](/missing/)")]);
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the link-check output never renders a page")),
    report: (diagnostic) => reported.push(diagnostic),
  };

  assert.equal(linkCheck.name, "link-check");
  const files: readonly OutputFile[] = await linkCheck.run(model, ctx);
  assert.deepEqual(files, []);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "link.missing-page");
  assert.equal(reported[0]?.severity, "warning");
  assert.equal(reported[0]?.pos?.line, 1);
});
