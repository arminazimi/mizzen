import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { changelogFeed, changelogFeedOutput } from "../src/outputs/changelog-feed.ts";

const pos = { file: "test/no-such-changelog/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

function heading(depth: Heading["depth"], id: string, text: string, line: number): Heading {
  return { depth, id, text, pos: { ...pos, line, endLine: line, endColumn: text.length + 1 } };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The output reads no render host and reports nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the changelog feed never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return changelogFeedOutput.run(model, ctx);
}

async function only(model: Site): Promise<string> {
  const files = await run(model);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "changelog.xml");
  return String(files[0]?.contents);
}

/** One parsed `<entry>` block. */
interface Entry {
  readonly title: string;
  readonly link: string;
  readonly id: string;
  readonly updated: string;
}

/** The entries, in the order the feed lists them. */
function entries(xml: string): Entry[] {
  return [...xml.matchAll(/ {2}<entry>\n([\s\S]*?) {2}<\/entry>/g)].map((block) => {
    const body = block[1] ?? "";
    const field = (name: string): string => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? "";
    const link = /<link href="([^"]*)" rel="alternate" type="text\/html"\/>/.exec(body)?.[1] ?? "";
    return { title: field("title"), id: field("id"), updated: field("updated"), link };
  });
}

/** A dated changelog page, with the headings a release feed reads. */
function changelog(headings: readonly Heading[], overrides: Partial<Page> = {}): Page {
  return page("/changelog/", {
    title: "Changelog",
    source: { ...pos, file: "changelog.md" },
    headings,
    ...overrides,
  });
}

test("the output is named after its file and writes changelog.xml", async () => {
  assert.equal(changelogFeedOutput.name, "changelog-feed");
  const files = await run(
    site([changelog([heading(2, "v1-0-0", "1.0.0 — 2026-10-01", 3)])], { url: "https://x.io" }),
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ["changelog.xml"],
  );
});

test("the changelog page is the first, by URL, with changelog: true, then CHANGELOG.md, then /changelog/", async () => {
  const flagged = page("/notes/", {
    source: { ...pos, file: "notes.md" },
    frontMatter: { changelog: true },
    headings: [heading(2, "a", "Flagged 2026-11-01", 2)],
  });
  const named = page("/releases/", {
    source: { ...pos, file: "CHANGELOG.md" },
    headings: [heading(2, "b", "Named 2026-10-01", 2)],
  });
  const byUrl = goodChangelog();
  const xml = await only(site([byUrl, named, flagged], { url: "https://x.io" }));
  assert.deepEqual(
    entries(xml).map((entry) => entry.title),
    ["Flagged 2026-11-01"],
  );

  const namedXml = await only(site([byUrl, named], { url: "https://x.io" }));
  assert.deepEqual(
    entries(namedXml).map((entry) => entry.title),
    ["Named 2026-10-01"],
  );

  const urlXml = await only(site([byUrl], { url: "https://x.io" }));
  assert.deepEqual(
    entries(urlXml).map((entry) => entry.title),
    ["1.0.0 — 2026-10-01"],
  );
});

/** A page at `/changelog/` with one dated release heading. */
function goodChangelog(): Page {
  return changelog([heading(2, "v1-0-0", "1.0.0 — 2026-10-01", 3)]);
}

test("two candidates of the same kind pick the lowest URL every time", async () => {
  const later = page("/z/changelog/", {
    frontMatter: { changelog: true },
    headings: [heading(2, "z", "Z 2026-10-01", 2)],
  });
  const earlier = page("/a/changelog/", {
    frontMatter: { changelog: true },
    headings: [heading(2, "a", "A 2026-10-01", 2)],
  });
  const xml = await only(site([later, earlier], { url: "https://x.io" }));
  assert.deepEqual(
    entries(xml).map((entry) => entry.title),
    ["A 2026-10-01"],
  );
});

test("entries are the h2 headings, or the h3 headings when there is no h2", async () => {
  const xml = await only(
    site(
      [
        changelog([
          heading(1, "title", "Changelog", 1),
          heading(2, "v2", "2.0.0 — 2026-11-01", 3),
          heading(3, "fixed", "Fixed 2026-10-15", 5),
          heading(2, "v1", "1.0.0 — 2026-10-01", 9),
          heading(4, "detail", "Detail 2026-12-01", 11),
        ]),
      ],
      { url: "https://x.io" },
    ),
  );
  assert.deepEqual(
    entries(xml).map((entry) => entry.title),
    ["2.0.0 — 2026-11-01", "1.0.0 — 2026-10-01"],
  );

  const h3Xml = await only(
    site(
      [
        changelog([
          heading(1, "title", "Changelog", 1),
          heading(3, "beta", "Beta 2026-11-01", 3),
          heading(3, "alpha", "Alpha 2026-10-01", 7),
        ]),
      ],
      { url: "https://x.io" },
    ),
  );
  assert.deepEqual(
    entries(h3Xml).map((entry) => entry.title),
    ["Beta 2026-11-01", "Alpha 2026-10-01"],
  );
});

test("a heading's date comes first from its text, then updated, then last_modified_at; undated headings are skipped", async () => {
  const xml = await only(
    site(
      [
        changelog(
          [
            heading(2, "text", "From text 2026-11-02", 3),
            heading(2, "updated", "From updated", 5),
            heading(2, "modified", "From last_modified_at", 7),
            heading(2, "impossible", "Impossible 2026-02-30", 11),
          ],
          { frontMatter: { updated: "2026-10-02", last_modified_at: "2026-10-01" } },
        ),
      ],
      { url: "https://x.io" },
    ),
  );
  assert.deepEqual(
    entries(xml).map((entry) => [entry.title, entry.updated]),
    [
      ["From text 2026-11-02", "2026-11-02T00:00:00.000Z"],
      ["From updated", "2026-10-02T00:00:00.000Z"],
      ["From last_modified_at", "2026-10-02T00:00:00.000Z"],
      ["Impossible 2026-02-30", "2026-10-02T00:00:00.000Z"],
    ],
    "the heading date wins; front matter fills in; an impossible heading date falls back too",
  );

  const undated = await run(
    site([changelog([heading(2, "none", "No date here", 3)], { frontMatter: {} })], { url: "https://x.io" }),
  );
  assert.deepEqual(undated, [], "a heading with no date anywhere is left out");
});

test("the date and time of front matter reads the same in every time zone", async () => {
  const xml = await only(
    site(
      [
        changelog([heading(2, "v1", "1.0.0", 3)], {
          frontMatter: { last_modified_at: "2026-10-01T09:30:00+03:30" },
        }),
      ],
      { url: "https://x.io" },
    ),
  );
  assert.deepEqual(
    entries(xml).map((entry) => entry.updated),
    ["2026-10-01T06:00:00.000Z"],
  );
});

test("entries are newest first and keep document order on the same date", async () => {
  const xml = await only(
    site(
      [
        changelog([
          heading(2, "old", "Old 2026-09-01", 3),
          heading(2, "first", "First 2026-11-01", 5),
          heading(2, "second", "Second 2026-11-01", 7),
          heading(2, "middle", "Middle 2026-10-01", 9),
        ]),
      ],
      { url: "https://x.io" },
    ),
  );
  assert.deepEqual(
    entries(xml).map((entry) => entry.title),
    ["First 2026-11-01", "Second 2026-11-01", "Middle 2026-10-01", "Old 2026-09-01"],
  );
});

test("ids and links are absolute with a url and relative without one", async () => {
  const headings = [heading(2, "v1-0-0", "1.0.0 — 2026-10-01", 3)];

  const absolutePage = page("/evergreen/changelog/", {
    frontMatter: { changelog: true },
    source: { ...pos, file: "changelog.md" },
    headings,
  });
  const absolute = await only(site([absolutePage], { url: "https://x.io", base: "/evergreen" }));
  assert.match(absolute, /<link href="https:\/\/x\.io\/evergreen\/changelog\/" rel="alternate" type="text\/html"\/>/);
  assert.match(absolute, /<id>https:\/\/x\.io\/evergreen\/changelog\/#v1-0-0<\/id>/);
  assert.match(absolute, /<link href="https:\/\/x\.io\/evergreen\/changelog\/#v1-0-0" rel="alternate" type="text\/html"\/>/);
  assert.match(absolute, /<link href="https:\/\/x\.io\/evergreen\/changelog\.xml" rel="self" type="application\/atom\+xml"\/>/);

  const relative = await only(site([page("/changelog/", { headings, source: { ...pos, file: "changelog.md" } })]));
  assert.match(relative, /<link href="\/changelog\/" rel="alternate" type="text\/html"\/>/);
  assert.match(relative, /<id>\/changelog\/#v1-0-0<\/id>/);
  assert.match(relative, /<link href="\/changelog\/#v1-0-0" rel="alternate" type="text\/html"\/>/);
  assert.match(relative, /<link href="\/changelog\.xml" rel="self" type="application\/atom\+xml"\/>/);
  assert.doesNotMatch(relative, /(?:href="|>)(?:https?:\/\/)/, "no absolute URL without a site url");
});

test("the file is a valid Atom 1.0 feed", async () => {
  const xml = await only(site([goodChangelog()], { url: "https://x.io", title: "A & B <docs>", lang: "fa" }));

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom" xml:lang="fa">/);
  assert.match(xml, /\n {2}<title>A &amp; B &lt;docs&gt;<\/title>/);
  assert.match(xml, /\n {2}<id>https:\/\/x\.io\/changelog\.xml<\/id>/);
  assert.match(xml, /\n {2}<updated>2026-10-01T00:00:00\.000Z<\/updated>/);
  assert.match(xml, /\n {2}<author>\n {4}<name>A &amp; B &lt;docs&gt;<\/name>\n {2}<\/author>/);
  assert.match(xml, /\n {2}<link href="https:\/\/x\.io\/changelog\.xml" rel="self" type="application\/atom\+xml"\/>/);
  assert.match(xml, /\n {2}<link href="https:\/\/x\.io\/changelog\/" rel="alternate" type="text\/html"\/>/);
  assert.match(xml, /<\/feed>\n$/);

  const [entry] = entries(xml);
  assert.deepEqual(entry, {
    title: "1.0.0 — 2026-10-01",
    link: "https://x.io/changelog/#v1-0-0",
    id: "https://x.io/changelog/#v1-0-0",
    updated: "2026-10-01T00:00:00.000Z",
  });
  assert.equal((xml.match(/<entry>/g) ?? []).length, (xml.match(/<\/entry>/g) ?? []).length);
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos);/g, ""), /&/, "every ampersand starts a known entity");
});

test("XML-reserved characters are escaped in titles", async () => {
  const xml = await only(
    site([changelog([heading(2, "q", `Tom & Jerry's <1.0> "now" — 2026-10-01`, 3)])], { url: "https://x.io" }),
  );
  assert.match(xml, /<title>Tom &amp; Jerry&apos;s &lt;1\.0&gt; &quot;now&quot; — 2026-10-01<\/title>/);
});

test("no changelog page, or no dated heading, writes no file", async () => {
  assert.deepEqual(await run(site([page("/guide/", { headings: [heading(2, "a", "A 2026-10-01", 2)] })])), []);
  assert.deepEqual(await run(site([changelog([heading(2, "v1", "1.0.0", 3)])])), []);
  assert.deepEqual(
    await run(site([changelog([heading(2, "v1", "1.0.0", 3)], { frontMatter: { last_modified_at: "soon" } })])),
    [],
  );
  assert.deepEqual(await run(site([page("/changelog/", { kind: "app", headings: [heading(2, "v1", "V 2026-10-01", 2)] })])), []);
});

test("the same model writes the same bytes every time", async () => {
  const model = site(
    [
      changelog([
        heading(2, "b", "B 2026-10-02", 3),
        heading(2, "a", "A 2026-10-01", 5),
        heading(2, "c", "C 2026-10-02", 7),
      ]),
    ],
    { url: "https://x.io" },
  );
  const first = await run(model);
  const second = await run(model);
  assert.deepEqual(second, first);
  assert.equal((await changelogFeed(model))[0]?.contents, first[0]?.contents);
});
