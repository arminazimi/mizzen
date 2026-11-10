import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { related, relatedPages } from "../src/outputs/related.ts";

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

/** A heading with a real source span. */
function heading(id: string, text: string): Heading {
  return {
    depth: 2,
    id,
    text,
    pos: { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
}

interface PageOptions {
  readonly markdown?: string;
  readonly html?: string;
  readonly headings?: readonly Heading[];
  readonly source?: string;
  readonly kind?: Page["kind"];
}

/** A document page with the given body, headings, and source file. */
function page(url: string, options: PageOptions = {}): Page {
  const source = options.source ?? "guide/install.md";
  return {
    url,
    source: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: options.headings ?? [],
    html: options.html ?? "",
    markdown: options.markdown ?? "",
    kind: options.kind ?? "doc",
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The related entry list of one page. */
async function relatedOf(model: Site, url: string): Promise<ReadonlyArray<{ url: string; score: number }>> {
  const pages = await relatedPages(model);
  return (pages.find((entry) => entry.url === url)?.related ?? []).map(({ url: target, score }) => ({
    url: target,
    score,
  }));
}

/** The output never renders a page. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the related output never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return related.run(model, ctx);
}

test("the output is named after its file and writes sorted, stable JSON with a final line feed", async () => {
  assert.equal(related.name, "related");

  const model = site([page("/b/", { markdown: "[a](/a/)" }), page("/a/", { markdown: "[b](/b/)" })]);
  const files = await run(model);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "related.json");

  const text = String(files[0]!.contents);
  assert.ok(text.endsWith("\n"), "the file ends with a line feed");
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, "two-space JSON");
  const body = JSON.parse(text) as { version: number; pages: ReadonlyArray<{ url: string }> };
  assert.equal(body.version, 0);
  assert.deepEqual(
    body.pages.map((entry) => entry.url),
    ["/a/", "/b/"],
    "pages are sorted by URL",
  );
  assert.deepEqual(await run(model), files, "two runs write the same bytes");
});

test("pages that link to the same internal targets are related, and a link weighs two", async () => {
  const model = site([
    page("/a/", { markdown: "[one](/shared/)\n[two](/also/)" }),
    page("/b/", { markdown: "[one](/shared/)\n[two](/also/)" }),
    page("/c/", { markdown: "[other](/elsewhere/)" }),
  ]);

  assert.deepEqual(await relatedOf(model, "/a/"), [{ url: "/b/", score: 4 }]);
  assert.deepEqual(await relatedOf(model, "/b/"), [{ url: "/a/", score: 4 }]);
  assert.deepEqual(await relatedOf(model, "/c/"), []);

  const pages = await relatedPages(model);
  assert.deepEqual(pages.find((entry) => entry.url === "/a/")?.related[0], {
    url: "/b/",
    score: 4,
    sharedLinks: 2,
    sharedHeadings: 0,
  });
});

test("external links, anchors, and query-only links never relate pages", async () => {
  const body = [
    "[web](https://example.com/page)",
    "[cdn](//cdn.example.com/file.js)",
    "[mail](mailto:docs@example.com)",
    "[anchor](#install)",
    "[query](?page=2)",
  ].join("\n");
  const model = site([page("/a/", { markdown: body }), page("/b/", { markdown: body })]);

  assert.deepEqual(await relatedOf(model, "/a/"), []);
  assert.deepEqual(await relatedOf(model, "/b/"), []);
});

test("a source-file link resolves against the page's own folder, so pages in different folders agree", async () => {
  const model = site([
    page("/guide/a/", { source: "guide/a.md", markdown: "[commands](../commands.md)" }),
    page("/guide/b/", { source: "guide/b.md", markdown: "[commands](../commands.md)" }),
    page("/commands/", { source: "commands.md" }),
  ]);

  assert.deepEqual(await relatedOf(model, "/guide/a/"), [{ url: "/guide/b/", score: 2 }]);
  assert.deepEqual(await relatedOf(model, "/guide/b/"), [{ url: "/guide/a/", score: 2 }]);
  assert.deepEqual(await relatedOf(model, "/commands/"), []);
});

test("an HTML page contributes the hrefs of its links, and a relative href resolves against its URL", async () => {
  const model = site([
    page("/a/", { source: "a.md", markdown: "[shared](/shared/)" }),
    page("/ref/", {
      source: "ref.html",
      html: '<p><a href="../shared/">shared</a></p><pre>&lt;a href="/escaped/"&gt;</pre>',
    }),
  ]);

  assert.deepEqual(await relatedOf(model, "/a/"), [{ url: "/ref/", score: 2 }]);
  assert.deepEqual(await relatedOf(model, "/ref/"), [{ url: "/a/", score: 2 }]);
});

test("pages that share a heading are related, compared without case or extra spaces", async () => {
  const model = site([
    page("/a/", { headings: [heading("install", "Install")] }),
    page("/b/", { headings: [heading("installation", "  INSTALL  ")] }),
    page("/c/", { headings: [heading("other", "Other")] }),
  ]);

  assert.deepEqual(await relatedOf(model, "/a/"), [{ url: "/b/", score: 1 }]);
  const entry = (await relatedPages(model)).find((item) => item.url === "/a/")?.related[0];
  assert.deepEqual(entry, { url: "/b/", score: 1, sharedLinks: 0, sharedHeadings: 1 });
  assert.deepEqual(await relatedOf(model, "/c/"), []);
});

test("a heading with no text falls back to its id", async () => {
  const model = site([
    page("/a/", { headings: [heading("install", "")] }),
    page("/b/", { headings: [heading("install", "")] }),
  ]);
  assert.deepEqual(await relatedOf(model, "/a/"), [{ url: "/b/", score: 1 }]);
});

test("only the five highest scores are kept, ordered by score then URL", async () => {
  const target = page("/target/", {
    markdown: ["/common/", "/p1/", "/p2/", "/p3/", "/p4/", "/p5/"].map((url) => `[x](${url})`).join("\n"),
  });
  const candidates = Array.from({ length: 6 }, (_, index) =>
    page(`/p${index + 1}/`, {
      markdown: index === 5 ? "[common](/common/)" : `[common](/common/)\n[own](/p${index + 1}/)`,
    }),
  );

  const relatedToTarget = await relatedOf(site([target, ...candidates]), "/target/");
  assert.deepEqual(
    relatedToTarget.map((entry) => entry.url),
    ["/p1/", "/p2/", "/p3/", "/p4/", "/p5/"],
    "the five highest scores are kept",
  );
  assert.deepEqual(
    relatedToTarget.map((entry) => entry.score),
    [4, 4, 4, 4, 4],
  );
});

test("ties break by URL, pages come out by URL, and input order changes nothing", async () => {
  const pages = [
    page("/c/", { markdown: "[shared](/shared/)" }),
    page("/a/", { markdown: "[shared](/shared/)" }),
    page("/b/", { markdown: "[shared](/shared/)" }),
  ];
  const model = site(pages);
  const reversed = site([...pages].reverse());

  const once = await relatedPages(model);
  assert.deepEqual(
    once.map((entry) => entry.url),
    ["/a/", "/b/", "/c/"],
  );
  assert.deepEqual(
    once.find((entry) => entry.url === "/a/")?.related.map((entry) => entry.url),
    ["/b/", "/c/"],
    "equal scores order by URL",
  );
  assert.deepEqual(await relatedPages(reversed), once);
});

test("a site where nothing is shared has an empty list for every page", async () => {
  const model = site([
    page("/a/", { markdown: "[x](/x/)", headings: [heading("a", "A")] }),
    page("/b/", { markdown: "[y](/y/)", headings: [heading("b", "B")] }),
    page("/c/"),
  ]);

  const pages = await relatedPages(model);
  assert.deepEqual(
    pages.map((entry) => [entry.url, entry.related]),
    [
      ["/a/", []],
      ["/b/", []],
      ["/c/", []],
    ],
  );
});

test("a page with no links or headings is still listed, and a page is never related to itself", async () => {
  const model = site([
    page("/self/", { markdown: "[self](/self/)\n[self again](/self.html)" }),
    page("/empty/"),
  ]);

  assert.deepEqual(await relatedOf(model, "/self/"), [], "a self link is not another page");
  const pages = await relatedPages(model);
  assert.deepEqual(
    pages.map((entry) => entry.url),
    ["/empty/", "/self/"],
  );
  assert.deepEqual(pages.find((entry) => entry.url === "/empty/")?.related, []);
});

test("app and asset pages are not documents and do not appear", async () => {
  const model = site([
    page("/a/", { markdown: "[shared](/shared/)" }),
    page("/dashboard/", { kind: "app", markdown: "[shared](/shared/)" }),
    page("/logo.svg", { kind: "asset", markdown: "[shared](/shared/)" }),
  ]);

  const pages = await relatedPages(model);
  assert.deepEqual(
    pages.map((entry) => entry.url),
    ["/a/"],
  );
  assert.deepEqual(pages[0]?.related, []);
});

test("the site base is kept in link targets, so an absolute link and a source-file link agree", async () => {
  const model = site(
    [
      page("/docs/a/", { source: "a.md", markdown: "[b](b.md)" }),
      page("/docs/b/", { source: "b.md", markdown: "[b](/docs/b/)" }),
    ],
    { base: "/docs" },
  );

  assert.deepEqual(await relatedOf(model, "/docs/a/"), [{ url: "/docs/b/", score: 2 }]);
  assert.deepEqual(await relatedOf(model, "/docs/b/"), [{ url: "/docs/a/", score: 2 }]);
});
