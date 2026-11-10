import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { changesFeed, feed } from "../src/outputs/feed.ts";

const pos = { file: "test/no-such-feed-source/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The feed reads no render host and reports nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the feed never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return feed.run(model, ctx);
}

async function only(model: Site): Promise<string> {
  const files = await run(model);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "changes.xml");
  return String(files[0]?.contents);
}

/** The entry titles, in the order the feed lists them. */
function titles(xml: string): string[] {
  return [...xml.matchAll(/<entry>\n {4}<title>([^<]*)<\/title>/g)].map((m) => m[1] ?? "");
}

const hasGit = !spawnSync("git", ["--version"]).error;

/** A temporary git repository with `files` committed at the given committer dates; the caller removes it. */
function repository(files: readonly { readonly path: string; readonly date: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "feed-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Feed Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "feed@example.com"], { cwd: root });
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${file.path}\n`);
    execFileSync("git", ["add", "--", file.path], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", file.path], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: file.date, GIT_COMMITTER_DATE: file.date },
    });
  }
  return root;
}

test("the output is named after its file and writes changes.xml", async () => {
  assert.equal(feed.name, "feed");
  const files = await run(site([page("/a/", { frontMatter: { last_modified_at: "2026-10-01" } })], { url: "https://x.io" }));
  assert.deepEqual(
    files.map((f) => f.path),
    ["changes.xml"],
  );
});

test("the 30 most recently changed doc pages appear newest first, with absolute links and a base", async () => {
  const model = site(
    [
      page("/evergreen/b/", { title: "B", frontMatter: { last_modified_at: "2026-10-02" } }),
      page("/evergreen/a/", { title: "A", frontMatter: { last_modified_at: "2026-11-01T09:30:00+03:30" } }),
      page("/evergreen/dashboard/", { kind: "app", frontMatter: { last_modified_at: "2026-12-01" } }),
      page("/evergreen/logo.svg", { kind: "asset", frontMatter: { last_modified_at: "2026-12-01" } }),
      page("/evergreen/c/", { title: "C", frontMatter: { last_modified_at: "2026-10-02" } }),
    ],
    { url: "https://example.github.io", base: "/evergreen", lang: "fa", title: "Evergreen & Co" },
  );
  const xml = await only(model);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom" xml:lang="fa">/);
  assert.match(xml, /<title>Evergreen &amp; Co<\/title>/);
  assert.match(xml, /<link href="https:\/\/example\.github\.io\/evergreen\/changes\.xml" rel="self" type="application\/atom\+xml"\/>/);
  assert.match(xml, /<link href="https:\/\/example\.github\.io\/evergreen\/" rel="alternate" type="text\/html"\/>/);
  assert.match(xml, /<id>https:\/\/example\.github\.io\/evergreen\/changes\.xml<\/id>/);
  assert.match(xml, /<updated>2026-11-01T06:00:00\.000Z<\/updated>/);
  assert.deepEqual(titles(xml), ["A", "B", "C"], "newest first, then URL ascending on a tie");
  assert.match(xml, /<link href="https:\/\/example\.github\.io\/evergreen\/a\/" rel="alternate" type="text\/html"\/>/);
  assert.match(xml, /<id>https:\/\/example\.github\.io\/evergreen\/a\/<\/id>/);
  assert.match(xml, /<updated>2026-10-02T00:00:00\.000Z<\/updated>/);
});

test("the feed keeps the 30 newest entries and leaves the rest out", async () => {
  const pages: Page[] = [];
  for (let day = 1; day <= 35; day++) {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    pages.push(page(`/day-${String(day).padStart(2, "0")}/`, { title: `Day ${day}`, frontMatter: { last_modified_at: date } }));
  }
  const xml = await only(site(pages, { url: "https://x.io" }));
  const listed = titles(xml);
  assert.equal(listed.length, 30);
  assert.deepEqual(listed.slice(0, 2), ["Day 35", "Day 34"]);
  assert.deepEqual(listed.slice(-2), ["Day 7", "Day 6"]);
  assert.ok(!listed.includes("Day 5"));
});

test("XML-reserved characters are escaped and non-ASCII URLs are percent-encoded", async () => {
  const model = site(
    [
      page("/q&a/", {
        title: `Tom & Jerry's <guide> "one"`,
        frontMatter: { description: "A <b>bold</b> & 'quoted' summary.", last_modified_at: "2026-10-01" },
      }),
      page("/café/", { title: "Café", frontMatter: { last_modified_at: "2026-10-02" } }),
    ],
    { url: "https://x.io", title: "A & B <docs>" },
  );
  const xml = await only(model);
  assert.match(xml, /<title>A &amp; B &lt;docs&gt;<\/title>/);
  assert.match(xml, /<title>Tom &amp; Jerry&apos;s &lt;guide&gt; &quot;one&quot;<\/title>/);
  assert.match(xml, /<summary>A &lt;b&gt;bold&lt;\/b&gt; &amp; &apos;quoted&apos; summary\.<\/summary>/);
  assert.match(xml, /<id>https:\/\/x\.io\/q&amp;a\/<\/id>/);
  assert.match(xml, /<id>https:\/\/x\.io\/caf%C3%A9\/<\/id>/);
});

test("a site where no page has a date writes no file, and a site without a url writes none either", async () => {
  assert.deepEqual(await run(site([page("/a/"), page("/b/", { kind: "app" })], { url: "https://x.io" })), []);
  assert.deepEqual(await run(site([page("/a/", { frontMatter: { last_modified_at: "2026-10-01" } })])), []);
  assert.deepEqual(await run(site([page("/a/", { frontMatter: { last_modified_at: "2026-10-01" } })], { url: "example.com" })), []);
});

test("every date is read the same way in every time zone, and an impossible date is ignored", async () => {
  const model = site(
    [
      page("/space/", { frontMatter: { last_modified_at: "2026-10-01 09:30" } }),
      page("/offset/", { frontMatter: { last_modified_at: "2026-10-01T09:30:00+0330" } }),
      page("/fraction/", { frontMatter: { last_modified_at: "2026-10-01T09:30:00.25Z" } }),
      page("/impossible/", { frontMatter: { last_modified_at: "2026-02-30" } }),
      page("/soon/", { frontMatter: { last_modified_at: "soon" } }),
    ],
    { url: "https://x.io" },
  );
  const xml = await only(model);
  assert.deepEqual(
    [...xml.matchAll(/<id>([^<]*)<\/id>\n {4}<updated>([^<]*)<\/updated>/g)].map((m) => [m[1], m[2]]),
    [
      ["https://x.io/fraction/", "2026-10-01T09:30:00.250Z"],
      ["https://x.io/space/", "2026-10-01T09:30:00.000Z"],
      ["https://x.io/offset/", "2026-10-01T06:00:00.000Z"],
    ],
  );
  assert.ok(!xml.includes("/impossible/"));
  assert.ok(!xml.includes("/soon/"));
});

test(
  "without last_modified_at, the last commit date of the source file is used, and front matter still wins",
  { skip: hasGit ? false : "git is not installed" },
  async () => {
    const root = repository([
      { path: "guide/old.md", date: "2026-09-01T10:00:00Z" },
      { path: "guide/new.md", date: "2026-10-01T10:00:00Z" },
    ]);
    try {
      const model = site(
        [
          page("/old/", { title: "Old", source: { ...pos, file: "guide/old.md" } }),
          page("/new/", {
            title: "New",
            source: { ...pos, file: "guide/new.md" },
            frontMatter: { last_modified_at: "2026-11-01" },
          }),
          page("/missing/", { title: "Missing", source: { ...pos, file: "guide/missing.md" } }),
        ],
        { url: "https://x.io" },
      );
      const xml = String((await changesFeed(model, root))[0]?.contents);
      assert.deepEqual(titles(xml), ["New", "Old"], "front matter wins; a file git never saw is skipped");
      assert.match(xml, /<id>https:\/\/x\.io\/new\/<\/id>\n {4}<updated>2026-11-01T00:00:00\.000Z<\/updated>/);
      assert.match(xml, /<id>https:\/\/x\.io\/old\/<\/id>\n {4}<updated>2026-09-01T10:00:00\.000Z<\/updated>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the output reads git from the folder the build runs in, and the repository dir prefix is stripped",
  { skip: hasGit ? false : "git is not installed" },
  async () => {
    const root = repository([{ path: "docs/guide/install.md", date: "2026-10-05T12:00:00Z" }]);
    const siteRoot = join(root, "docs");
    const before = process.cwd();
    try {
      process.chdir(siteRoot);
      const model = site(
        [
          page("/install/", {
            title: "Install",
            source: { ...pos, file: "docs/guide/install.md" },
          }),
        ],
        { url: "https://x.io", repository: { url: "https://github.com/x/y", dir: "docs" } },
      );
      const xml = await only(model);
      assert.deepEqual(titles(xml), ["Install"]);
      assert.match(xml, /<updated>2026-10-05T12:00:00\.000Z<\/updated>/);
    } finally {
      process.chdir(before);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
