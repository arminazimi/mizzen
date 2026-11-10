import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { opensearch, opensearchDescription, opensearchLink, opensearchUrl } from "../src/outputs/opensearch.ts";
import { build } from "../src/pipeline/build.ts";

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

function page(url: string): Page {
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
  };
}

function site(overrides: Partial<SiteConfig> = {}, pages: readonly Page[] = [page("/guide/install/")]): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** A context that keeps every diagnostic reported to it, so a test can read them back. */
function recordingContext(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("opensearch never renders a page")),
    report: (d) => {
      reported.push(d);
    },
  };
  return { ctx, reported };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; reported: Diagnostic[] }> {
  const { ctx, reported } = recordingContext();
  const files = await opensearch.run(model, ctx);
  return { files, reported };
}

test("opensearch.xml is an OpenSearch 1.1 description of the site's search", async () => {
  const { files, reported } = await run(
    site({ title: "Example", description: "Docs for example", url: "https://example.com" }),
  );
  assert.deepEqual(reported, [], "a site with a url reports nothing");
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "opensearch.xml");
  assert.equal(
    files[0]?.contents,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
      "  <ShortName>Example</ShortName>",
      "  <Description>Docs for example</Description>",
      '  <Url rel="results" type="text/html" method="get" template="https://example.com/?q={searchTerms}"/>',
      "  <InputEncoding>UTF-8</InputEncoding>",
      "</OpenSearchDescription>",
      "",
    ].join("\n"),
  );
});

test("the template and the file address carry the base, so a site under /docs searches /docs", async () => {
  const model = site({ url: "https://example.com", base: "/docs" });
  assert.equal(opensearchUrl(model), "https://example.com/docs/opensearch.xml");
  const { files } = await run(model);
  assert.match(String(files[0]?.contents), /template="https:\/\/example\.com\/docs\/\?q=\{searchTerms\}"/);
});

test("a trailing slash on url does not put a double slash in the template", async () => {
  for (const url of ["https://example.com/", "https://example.com//"]) {
    const { files } = await run(site({ url }));
    assert.match(String(files[0]?.contents), /template="https:\/\/example\.com\/\?q=\{searchTerms\}"/);
  }
});

test("the description falls back to the title when the config has none", async () => {
  for (const description of [undefined, "", "   "]) {
    const model = description === undefined
      ? site({ title: "Example", url: "https://example.com" })
      : site({ title: "Example", description, url: "https://example.com" });
    const { files } = await run(model);
    assert.match(String(files[0]?.contents), /<Description>Example<\/Description>/);
  }
});

test("the title, description, and template are XML-escaped", async () => {
  const model = site({
    title: `Tom & Jerry <docs> "quoted" 'single'`,
    description: `A & B <C>`,
    url: "https://example.com",
    base: "/a&b",
  });
  const xml = String((await run(model)).files[0]?.contents);
  assert.ok(xml.includes("<ShortName>Tom &amp; Jerry &lt;docs&gt; &quot;quoted&quot; &apos;single&apos;</ShortName>"));
  assert.ok(xml.includes("<Description>A &amp; B &lt;C&gt;</Description>"));
  assert.ok(xml.includes('template="https://example.com/a&amp;b/?q={searchTerms}"'));
  assert.ok(!xml.includes("<docs>"), "no raw markup from the title");
});

test("without a url there is no file and no diagnostic, since the address cannot be made absolute", async () => {
  assert.equal(opensearchUrl(site()), undefined);
  assert.equal(opensearchLink(site()), undefined);
  for (const url of [undefined, "", "   "]) {
    const model = url === undefined ? site() : site({ url });
    const { files, reported } = await run(model);
    assert.deepEqual(files, [], `url ${JSON.stringify(url)}`);
    assert.deepEqual(reported, [], "an optional file never warns");
  }
});

test("the bytes are deterministic: the same model gives the same file", async () => {
  const first = await run(site({ title: "Example", description: "Docs", url: "https://example.com" }));
  const second = await run(site({ title: "Example", description: "Docs", url: "https://example.com" }));
  assert.deepEqual(second, first);

  const model = site({ url: "https://example.com" });
  assert.equal(opensearchDescription(model, "https://example.com"), opensearchDescription(model, "https://example.com"));
});

test("the head link names the description, its type, and its absolute address", () => {
  assert.deepEqual(opensearchLink(site({ title: "Example", url: "https://example.com", base: "/docs" })), {
    rel: "search",
    href: "https://example.com/docs/opensearch.xml",
    attrs: { type: "application/opensearchdescription+xml", title: "Example" },
  });
});

test("the output is named opensearch and writes one file", async () => {
  assert.equal(opensearch.name, "opensearch");
  const { files } = await run(site({ url: "https://example.com" }));
  assert.deepEqual(
    files.map((file) => file.path),
    ["opensearch.xml"],
  );
});

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opensearch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The `<link>` tags of a built page with `rel="search"`. */
function searchLinks(html: string): string[] {
  return (html.match(/<link\b[^>]*>/g) ?? []).filter((tag) => tag.includes('rel="search"'));
}

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("a built page's head links the written file, and a site without a url writes neither", async () => {
  const parent = mkdtempSync(join(tmpdir(), "opensearch-out-"));
  try {
    const withUrl = tree({
      "mizzen.yml": "title: Example\nurl: https://example.com\nlang: en\n",
      "index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const out = join(parent, "with-url");
    const result = await build({ root: withUrl, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    assert.ok(existsSync(join(out, "opensearch.xml")), "the output writes the file");
    const links = searchLinks(readFileSync(join(out, "index.html"), "utf8"));
    assert.equal(links.length, 1);
    assert.match(links[0]!, /type="application\/opensearchdescription\+xml"/);
    assert.match(links[0]!, /title="Example"/);
    assert.match(links[0]!, /href="https:\/\/example\.com\/opensearch\.xml"/);

    const withoutUrl = tree({
      "mizzen.yml": "title: Example\nlang: en\n",
      "index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const bare = join(parent, "without-url");
    const bareResult = await build({ root: withoutUrl, out: bare, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(
      bareResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    assert.equal(existsSync(join(bare, "opensearch.xml")), false, "no file without a url");
    assert.deepEqual(searchLinks(readFileSync(join(bare, "index.html"), "utf8")), [], "and no head link");

    rmSync(withUrl, { recursive: true, force: true });
    rmSync(withoutUrl, { recursive: true, force: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
