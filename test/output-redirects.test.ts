import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { redirects } from "../src/outputs/redirects.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site model with the config keys the redirects output reads, and no navigation or data. */
function site(options: {
  readonly pages?: readonly Page[];
  readonly url?: string;
  readonly base?: string;
  readonly redirects?: Readonly<Record<string, string>>;
}): Site {
  return {
    config: {
      title: "Example",
      ...(options.url === undefined ? {} : { url: options.url }),
      base: options.base ?? "",
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
      redirects: options.redirects ?? {},
      outputs: {},
    },
    pages: options.pages ?? [],
    nav: {},
    data: {},
  };
}

function page(url: string, kind: Page["kind"] = "doc", frontMatter: Page["frontMatter"] = {}): Page {
  return {
    url,
    source: pos,
    frontMatter,
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind,
  };
}

/** A context that keeps every diagnostic, so a test can check what the output reported. */
function collecting(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the redirects output never renders a page")),
    report: (d) => reported.push(d),
  };
  return { ctx, reported };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; reported: Diagnostic[] }> {
  const { ctx, reported } = collecting();
  const files = await redirects.run(model, ctx);
  return { files, reported };
}

function byPath(files: readonly OutputFile[]): Map<string, OutputFile> {
  return new Map(files.map((f) => [f.path, f]));
}

test("a config redirect is one complete HTML page with a meta refresh, a canonical link, a fallback link, and one script", async () => {
  const { files, reported } = await run(
    site({ url: "https://example.com", base: "/docs", redirects: { "/old/": "/new/" } }),
  );
  assert.deepEqual(reported, [], "a valid redirect reports nothing");
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "old/index.html"]);
  assert.equal(byPath(files).get("_redirects")?.contents, "/old/ https://example.com/docs/new/ 301\n");
  assert.equal(
    byPath(files).get("old/index.html")?.contents,
    [
      "<!doctype html>",
      '<html lang="en" dir="ltr">',
      "<head>",
      '<meta charset="utf-8">',
      "<title>Redirecting</title>",
      '<link rel="canonical" href="https://example.com/docs/new/">',
      '<meta name="robots" content="noindex">',
      '<meta http-equiv="refresh" content="0; url=https://example.com/docs/new/">',
      '<script>location.replace("https://example.com/docs/new/")</script>',
      "</head>",
      "<body>",
      '<p>This page moved to <a href="https://example.com/docs/new/">https://example.com/docs/new/</a>.</p>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
});

test("config redirects use the base and the site url, an https target is kept as written, and files come back sorted", async () => {
  const { files, reported } = await run(
    site({
      url: "https://example.com/",
      base: "/docs",
      redirects: {
        "/z-last/": "/",
        "/a-first": "/new/",
        "/old.html": "https://elsewhere.example/other/",
      },
    }),
  );
  assert.deepEqual(reported, []);
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "a-first/index.html", "old.html", "z-last/index.html"]);
  const contents = byPath(files);
  assert.match(String(contents.get("a-first/index.html")?.contents), /content="0; url=https:\/\/example\.com\/docs\/new\/"/);
  assert.match(String(contents.get("z-last/index.html")?.contents), /content="0; url=https:\/\/example\.com\/docs\/"/);
  assert.match(String(contents.get("old.html")?.contents), /content="0; url=https:\/\/elsewhere\.example\/other\/"/);
  assert.equal(
    contents.get("_redirects")?.contents,
    [
      "/a-first https://example.com/docs/new/ 301",
      "/old.html https://elsewhere.example/other/ 301",
      "/z-last/ https://example.com/docs/ 301",
      "",
    ].join("\n"),
    "one sorted line per entry, and an absolute target keeps the base it was given",
  );
});

test("redirect_from takes a string or a list, and without a site url the target stays site-relative with the base", async () => {
  const { files, reported } = await run(
    site({
      base: "/docs",
      pages: [
        page("/docs/new/", "doc", { redirect_from: "/one/" }),
        page("/docs/two/", "doc", { redirect_from: ["/two-a/", "/two-b"] }),
      ],
    }),
  );
  assert.deepEqual(reported, []);
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "one/index.html", "two-a/index.html", "two-b/index.html"]);
  const contents = byPath(files);
  assert.match(String(contents.get("one/index.html")?.contents), /content="0; url=\/docs\/new\/"/);
  assert.match(String(contents.get("two-a/index.html")?.contents), /content="0; url=\/docs\/two\/"/);
  assert.match(String(contents.get("two-b/index.html")?.contents), /content="0; url=\/docs\/two\/"/);
  assert.ok(
    !String(contents.get("one/index.html")?.contents).includes("https://"),
    "no site url means no absolute target",
  );
  assert.equal(
    contents.get("_redirects")?.contents,
    ["/one/ /new/ 301", "/two-a/ /two/ 301", "/two-b /two/ 301", ""].join("\n"),
    "_redirects is relative to the output folder, so base is stripped from both ends",
  );
});

test("a trailing slash and no trailing slash name the same pretty file", async () => {
  const { files, reported } = await run(
    site({ redirects: { "/with-slash/": "/new/", "/without-slash": "/new/" } }),
  );
  assert.deepEqual(reported, []);
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "with-slash/index.html", "without-slash/index.html"]);
  assert.equal(
    byPath(files).get("_redirects")?.contents,
    ["/with-slash/ /new/ 301", "/without-slash /new/ 301", ""].join("\n"),
  );
});

test("a redirect that hides a real page is an error and writes nothing", async () => {
  const { files, reported } = await run(
    site({
      base: "/docs",
      pages: [page("/docs/old/", "doc")],
      redirects: { "/old": "/new/" },
    }),
  );
  assert.deepEqual(files, [], "the page keeps its file");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "redirects.over-page");
  assert.equal(reported[0]?.severity, "error");
  assert.match(reported[0]?.message ?? "", /\/docs\/old\//);
});

test("an old path claimed twice is an error, and the config claim wins over front matter", async () => {
  const { files, reported } = await run(
    site({
      pages: [page("/new/", "doc", { redirect_from: ["/old", "/old/"] })],
      redirects: { "/old/": "/from-config/" },
    }),
  );
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "old/index.html"]);
  assert.match(String(files[1]?.contents), /url=\/from-config\//, "the first claim, the config, sets the target");
  assert.equal(byPath(files).get("_redirects")?.contents, "/old/ /from-config/ 301\n");
  assert.equal(reported.length, 2);
  assert.deepEqual(
    reported.map((d) => d.id),
    ["redirects.duplicate", "redirects.duplicate"],
  );
  assert.ok(reported.every((d) => d.severity === "error"));
});

test("every value is escaped for its place in the document, and a script cannot be closed early", async () => {
  const target = `/a&b/"quote"/'apos'/</script><script>alert(1)</script>/`;
  const { files, reported } = await run(site({ redirects: { "/old/": target } }));
  assert.deepEqual(reported, []);
  const html = String(byPath(files).get("old/index.html")?.contents);
  assert.ok(html.includes('href="/a&amp;b/&quot;quote&quot;/&#39;apos&#39;/&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;/"'));
  assert.ok(html.includes("url=/a&amp;b/&quot;quote&quot;/&#39;apos&#39;/&lt;/script&gt;"), "the meta refresh is escaped");
  assert.ok(html.includes("\\u0026"), "the script escapes & as a Unicode escape");
  assert.ok(html.includes("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)"), "the script escapes < and >");
  assert.ok(!html.includes("</script><script>"), "the target cannot close the script element");
});

test("entries come back sorted by path, whatever order the model and the config listed them in", async () => {
  const { files, reported } = await run(
    site({
      pages: [
        page("/z/", "doc", { redirect_from: "/m/" }),
        page("/a/", "doc", { redirect_from: "/b/" }),
      ],
      redirects: { "/y/": "/", "/x/": "/" },
    }),
  );
  assert.deepEqual(reported, []);
  assert.deepEqual(files.map((f) => f.path), [
    "_redirects",
    "b/index.html",
    "m/index.html",
    "x/index.html",
    "y/index.html",
  ]);
  assert.equal(new Set(files.map((f) => f.path)).size, files.length, "no output path is written twice");
  assert.equal(
    byPath(files).get("_redirects")?.contents,
    ["/b/ /a/ 301", "/m/ /z/ 301", "/x/ / 301", "/y/ / 301", ""].join("\n"),
    "_redirects sorts by old path across the config and the front matter",
  );
});

test("an unsafe old path or a target that is neither a site path nor an https URL is an error, not a throw", async () => {
  const { files, reported } = await run(
    site({
      pages: [page("/new/", "doc", { redirect_from: "/../escape/" })],
      redirects: { "/bad?target/": "/new/", "/old/": "new/" },
    }),
  );
  assert.deepEqual(files, []);
  assert.deepEqual(
    reported.map((d) => d.id),
    [
      "redirects.invalid-old-path",
      "redirects.invalid-target",
      "redirects.invalid-old-path",
    ],
  );
  assert.ok(reported.every((d) => d.severity === "error"));
});

test("a site with no redirects writes no empty _redirects file", async () => {
  const { files, reported } = await run(site({}));
  assert.deepEqual(reported, []);
  assert.deepEqual(files, []);
});

test("a redirect that points at itself is a loop, reported once, with its HTML page kept and no _redirects line", async () => {
  const { files, reported } = await run(site({ redirects: { "/loop/": "/loop/" } }));
  assert.deepEqual(files.map((f) => f.path), ["loop/index.html"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "redirects.loop");
  assert.equal(reported[0]?.severity, "error");
  assert.match(reported[0]?.message ?? "", /"\/loop\/" points to itself/);
  assert.match(String(files[0]?.contents), /url=\/loop\//, "the HTML page is unchanged");
});

test("two redirects that point at each other are one loop, and neither gets a _redirects line", async () => {
  const { files, reported } = await run(site({ redirects: { "/a/": "/b/", "/b/": "/a/" } }));
  assert.deepEqual(files.map((f) => f.path), ["a/index.html", "b/index.html"]);
  assert.deepEqual(
    reported.map((d) => d.id),
    ["redirects.loop"],
  );
  assert.equal(reported[0]?.severity, "error");
  assert.match(reported[0]?.message ?? "", /"\/a\/" -> "\/b\/" -> "\/a\/"/);
});

test("a chain is a warning and _redirects points at the final target while the HTML pages keep their first hop", async () => {
  const { files, reported } = await run(site({ redirects: { "/a/": "/b/", "/b/": "/c/" } }));
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "a/index.html", "b/index.html"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "redirects.chain");
  assert.equal(reported[0]?.severity, "warning");
  assert.match(reported[0]?.message ?? "", /"\/a\/" passes through "\/b\/" and ends at "\/c\/"/);
  assert.equal(
    byPath(files).get("_redirects")?.contents,
    ["/a/ /c/ 301", "/b/ /c/ 301", ""].join("\n"),
  );
  assert.match(
    String(byPath(files).get("a/index.html")?.contents),
    /url=\/b\//,
    "the HTML page still sends readers to the next old path",
  );
});

test("a chain can pass through a redirect_from old path, and reports the config entry that starts it", async () => {
  const { files, reported } = await run(
    site({
      base: "/docs",
      pages: [page("/docs/new/", "doc", { redirect_from: "/b/" })],
      redirects: { "/a/": "/b/" },
    }),
  );
  assert.deepEqual(files.map((f) => f.path), ["_redirects", "a/index.html", "b/index.html"]);
  assert.deepEqual(
    reported.map((d) => d.id),
    ["redirects.chain"],
  );
  assert.match(reported[0]?.message ?? "", /"\/b\/" and ends at "\/docs\/new\/"/);
  assert.equal(
    byPath(files).get("_redirects")?.contents,
    ["/a/ /new/ 301", "/b/ /new/ 301", ""].join("\n"),
  );
});

test("a chain of several hops flattens to an external target and warns for each hop that is still a redirect", async () => {
  const { files, reported } = await run(
    site({ redirects: { "/a/": "/b/", "/b/": "/c/", "/c/": "https://elsewhere.example/" } }),
  );
  assert.deepEqual(
    reported.map((d) => d.id),
    ["redirects.chain", "redirects.chain"],
  );
  assert.equal(
    byPath(files).get("_redirects")?.contents,
    [
      "/a/ https://elsewhere.example/ 301",
      "/b/ https://elsewhere.example/ 301",
      "/c/ https://elsewhere.example/ 301",
      "",
    ].join("\n"),
  );
});
