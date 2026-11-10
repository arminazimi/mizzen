import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, RepositoryConfig, Site, SiteConfig } from "../src/contracts/index.ts";
import { suggestIssueLink, suggestLinksOf } from "../src/outputs/suggest-links.ts";

const FILE = "guide/install.md";

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

/** One heading with a real source span, at the given line. */
function heading(id: string, text: string, line: number): Heading {
  return {
    depth: 2,
    id,
    text,
    pos: { file: FILE, line, column: 1, endLine: line, endColumn: 1 },
  };
}

/** A document page; `headings` default to one heading with a real span. */
function page(url: string, title: string, headings: readonly Heading[] = [heading("install", "Install", 12)]): Page {
  return {
    url,
    source: { file: FILE, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title,
    lang: "en",
    dir: "ltr",
    headings,
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[], repository?: RepositoryConfig): Site {
  return {
    config: config(repository === undefined ? {} : { repository }),
    pages,
    nav: {},
    data: {},
  };
}

function github(): RepositoryConfig {
  return { url: "https://github.com/arminazimi/evergreen" };
}

function gitlab(): RepositoryConfig {
  return { url: "https://gitlab.com/group/project" };
}

/** The query value at `key`, decoded the way a browser sends the form. */
function value(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

test("GitHub: the link opens a new issue with the title, page, source line, and heading", () => {
  const target = page("/guide/install/", "Install");
  const url = suggestIssueLink(github(), target, target.headings[0]!);
  assert.ok(url !== undefined);

  assert.ok(url.startsWith("https://github.com/arminazimi/evergreen/issues/new?title="));
  assert.equal(value(url, "title"), "Suggest edit: Install — Install");
  assert.equal(
    value(url, "body"),
    "Suggest an edit to this heading.\n\nPage: /guide/install/\nSource: guide/install.md:12\nHeading: install\n",
  );
});

test("GitLab: the link uses the `/-/issues/new` form and GitLab's query keys", () => {
  const target = page("/guide/install/", "Install");
  const url = suggestIssueLink(gitlab(), target, target.headings[0]!);
  assert.ok(url !== undefined);

  assert.ok(url.startsWith("https://gitlab.com/group/project/-/issues/new?issue[title]="));
  assert.equal(value(url, "issue[title]"), "Suggest edit: Install — Install");
  assert.equal(
    value(url, "issue[description]"),
    "Suggest an edit to this heading.\n\nPage: /guide/install/\nSource: guide/install.md:12\nHeading: install\n",
  );
});

test("self-hosted GitLab is detected from the hostname, and a `.git` suffix and slash are dropped", () => {
  const target = page("/guide/install/", "Install");
  const url = suggestIssueLink({ url: "https://gitlab.example.com/team/docs.git/" }, target, target.headings[0]!);
  assert.ok(url !== undefined);
  assert.ok(url.startsWith("https://gitlab.example.com/team/docs/-/issues/new?issue[title]="));
});

test("Persian text, quotes, and newlines are encoded, and the title stays one line", () => {
  const target = page("/راهنما/نصب/", 'راهنمای "نصب"\nسریع', [
    heading("نصب-سریع", 'چگونه "نصب" کنیم؟', 7),
  ]);
  const url = suggestIssueLink(github(), target, target.headings[0]!);
  assert.ok(url !== undefined);

  const title = value(url, "title");
  assert.equal(title, 'Suggest edit: راهنمای "نصب" سریع — چگونه "نصب" کنیم؟');
  assert.ok(!title?.includes("\n"));

  // The encoded URL carries no raw spaces, quotes, or newlines.
  assert.ok(!url.includes(" "));
  assert.ok(!url.includes("\n"));
  assert.ok(url.includes(encodeURIComponent('"')));

  const body = value(url, "body");
  assert.ok(body?.includes("Page: /راهنما/نصب/"));
});

test("a long body is truncated so the whole URL stays under 8 KB, and the title is kept", () => {
  const longId = `heading-${"x".repeat(12000)}`;
  const target = page(`/${"y".repeat(4000)}/`, "Install", [heading(longId, "Install", 12)]);
  const url = suggestIssueLink(github(), target, target.headings[0]!);
  assert.ok(url !== undefined);

  assert.ok(url.length <= 8000, `URL length ${url.length} is under 8000`);
  assert.equal(value(url, "title"), "Suggest edit: Install — Install");
  const body = value(url, "body");
  assert.ok(body?.startsWith("Suggest an edit to this heading.\n\nPage: /"));
  assert.ok(body?.endsWith("…"), "the cut body ends with an ellipsis");
  assert.ok(body?.includes("Source: guide/install.md:12"));
});

test("the title is capped at 256 code points", () => {
  const target = page("/guide/install/", "Page ".repeat(100), [heading("install", "Heading ".repeat(100), 12)]);
  const url = suggestIssueLink(github(), target, target.headings[0]!);
  assert.ok(url !== undefined);

  const title = value(url, "title");
  assert.ok(title !== null);
  assert.equal([...title].length, 256);
  assert.ok(title.endsWith("…"));
});

test("there is no link without a repository, a web URL, or a page URL", () => {
  const target = page("/guide/install/", "Install");
  assert.equal(suggestIssueLink(undefined, target, target.headings[0]!), undefined);
  assert.equal(suggestIssueLink({ url: "" }, target, target.headings[0]!), undefined);
  assert.equal(suggestIssueLink({ url: "git@github.com:arminazimi/evergreen.git" }, target, target.headings[0]!), undefined);
  assert.equal(suggestIssueLink(github(), page("", "Install"), target.headings[0]), undefined);
  assert.deepEqual(suggestLinksOf(site([target])), []);
});

test("a heading that is not in the page, or a generated heading with no position, has no link", () => {
  const target = page("/guide/install/", "Install");
  assert.equal(suggestIssueLink(github(), target, heading("missing", "Missing", 20)), undefined);
  assert.equal(suggestIssueLink(github(), target, { ...target.headings[0]!, id: "" }), undefined);

  const generated = { ...target.headings[0]!, pos: undefined } as unknown as Heading;
  const generatedPage = page("/guide/install/", "Install", [generated]);
  assert.equal(suggestIssueLink(github(), generatedPage, generated), undefined);

  const zeroLine = { ...target.headings[0]!, pos: { ...target.headings[0]!.pos, line: 0 } };
  const zeroLinePage = page("/guide/install/", "Install", [zeroLine]);
  assert.equal(suggestIssueLink(github(), zeroLinePage, zeroLine), undefined);

  const emptyId = page("/guide/install/", "Install", [heading("", "Generated", 2)]);
  assert.equal(suggestIssueLink(github(), emptyId, emptyId.headings[0]!), undefined);
});

test("suggestLinksOf covers every positioned heading, in page URL then source order", () => {
  const second = page("/b/", "B", [heading("b-2", "Second", 40), heading("b-1", "First", 20)]);
  const first = page("/a/", "A", [heading("a-1", "Only", 8)]);
  const links = suggestLinksOf(site([second, first], github()));

  assert.deepEqual(
    links.map((link) => [link.page, link.heading, link.line]),
    [
      ["/a/", "a-1", 8],
      ["/b/", "b-1", 20],
      ["/b/", "b-2", 40],
    ],
  );
  assert.equal(links[0]?.text, "Only");
  assert.ok(links[0]?.url.includes("/issues/new?title="));
});

test("the same site gives the same links on every call", () => {
  const pages = [
    page("/b/", "B", [heading("b-2", "Second", 40), heading("b-1", "First", 20)]),
    page("/a/", "A", [heading("a-1", "Only", 8)]),
  ];
  const model = site(pages, github());
  const once = suggestLinksOf(model);
  const twice = suggestLinksOf({ ...model, pages: [...model.pages].reverse() });
  assert.deepEqual(twice, once);
});
