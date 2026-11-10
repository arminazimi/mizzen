import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, RepositoryConfig, Site, SiteConfig } from "../src/contracts/index.ts";
import { editLinksOf } from "../src/outputs/edit-links.ts";

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

function site(pages: readonly Page[], repository?: RepositoryConfig): Site {
  return { config: config(repository === undefined ? {} : { repository }), pages, nav: {}, data: {} };
}

const GITHUB = "https://github.com/acme/site";
const GITLAB = "https://gitlab.com/acme/site";

test("GitHub links go to `/edit/<branch>/<path>`, with the source file and page URL reported beside them", () => {
  const source = { ...pos, file: "docs/guide/install.md" };
  const links = editLinksOf(site([page("/guide/install/", { source })], { url: GITHUB, dir: "docs" }));

  assert.deepEqual(links, [
    {
      url: "/guide/install/",
      source: "docs/guide/install.md",
      editUrl: "https://github.com/acme/site/edit/main/docs/guide/install.md",
    },
  ]);
});

test("gitlab.com links go to `/-/edit/<branch>/<path>`", () => {
  const links = editLinksOf(site([page("/guide/install/")], { url: GITLAB }));

  assert.equal(links.length, 1);
  assert.equal(links[0]!.editUrl, "https://gitlab.com/acme/site/-/edit/main/guide/install.md");
});

test("a self-hosted GitLab, whose host names gitlab, gets the GitLab shape", () => {
  const links = editLinksOf(site([page("/guide/install/")], { url: "https://gitlab.example.com/acme/site/" }));

  assert.deepEqual(
    links.map((link) => link.editUrl),
    ["https://gitlab.example.com/acme/site/-/edit/main/guide/install.md"],
    "the trailing slash of the repository URL is not repeated",
  );
});

test("a custom branch is one encoded path segment, so a branch with a slash stays one segment", () => {
  const tree = editLinksOf(site([page("/guide/install/")], { url: GITHUB, branch: "v2" }));
  assert.equal(tree[0]!.editUrl, "https://github.com/acme/site/edit/v2/guide/install.md");

  const slash = editLinksOf(site([page("/guide/install/")], { url: GITHUB, branch: "release/2.0" }));
  assert.equal(slash[0]!.editUrl, "https://github.com/acme/site/edit/release%2F2.0/guide/install.md");
});

test("the repository dir is already in the source file and is not added twice", () => {
  const source = { ...pos, file: "docs/guide/install.md" };
  const links = editLinksOf(site([page("/guide/install/", { source })], { url: GITHUB, dir: "docs" }));

  assert.equal(links[0]!.source, "docs/guide/install.md");
  assert.equal(links[0]!.editUrl, "https://github.com/acme/site/edit/main/docs/guide/install.md");
});

test("each path segment is encoded while the separators stay", () => {
  const source = { ...pos, file: "guide/my notes#1 & draft?.md" };
  const links = editLinksOf(site([page("/guide/notes/", { source })], { url: GITLAB }));

  assert.equal(
    links[0]!.editUrl,
    "https://gitlab.com/acme/site/-/edit/main/guide/my%20notes%231%20%26%20draft%3F.md",
  );
});

test("a page without a source path, an app page, and an asset page get no link", () => {
  const pages = [
    page("/empty/", { source: { ...pos, file: "" } }),
    page("/spaces/", { source: { ...pos, file: "   " } }),
    page("/dashboard/", { kind: "app" }),
    page("/logo.svg", { kind: "asset" }),
    page("/guide/install/"),
  ];

  assert.deepEqual(
    editLinksOf(site(pages, { url: GITHUB })).map((link) => link.url),
    ["/guide/install/"],
  );
});

test("without a repository, or on a forge whose edit URL shape is unknown, there are no links", () => {
  assert.deepEqual(editLinksOf(site([page("/guide/install/")])), []);
  assert.deepEqual(editLinksOf(site([page("/guide/install/")], { url: "https://codeberg.org/acme/site" })), []);
  assert.deepEqual(editLinksOf(site([page("/guide/install/")], { url: "not a url" })), []);
});

test("links are sorted by page URL, whatever order the model had", () => {
  const links = editLinksOf(
    site([page("/b/"), page("/a/"), page("/c/")], { url: GITHUB }),
  );

  assert.deepEqual(
    links.map((link) => link.url),
    ["/a/", "/b/", "/c/"],
  );
  assert.deepEqual(
    links.map((link) => link.editUrl),
    [
      "https://github.com/acme/site/edit/main/guide/install.md",
      "https://github.com/acme/site/edit/main/guide/install.md",
      "https://github.com/acme/site/edit/main/guide/install.md",
    ],
    "the URL alone does not depend on the page's URL",
  );
});

test("the same model gives the same list on every call", () => {
  const model = site([page("/b/"), page("/a/")], { url: GITHUB });
  assert.deepEqual(editLinksOf(model), editLinksOf(model));
});
