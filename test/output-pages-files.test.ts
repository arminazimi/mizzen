import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { cnameHost, pagesFiles } from "../src/outputs/pages-files.ts";

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

function site(overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages: [], nav: {}, data: {} };
}

/** A context that keeps every diagnostic, so a test can check the output reported nothing. */
function collecting(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the pages-files output never renders a page")),
    report: (d) => reported.push(d),
  };
  return { ctx, reported };
}

async function run(model: Site = site()): Promise<readonly OutputFile[]> {
  const { ctx, reported } = collecting();
  const files = await pagesFiles.run(model, ctx);
  assert.deepEqual(reported, [], "the output reports no diagnostic");
  return files;
}

/** Paths in the order the output returned them. */
function paths(files: readonly OutputFile[]): string[] {
  return files.map((file) => file.path);
}

test("the output is named pages-files and always writes an empty .nojekyll", async () => {
  assert.equal(pagesFiles.name, "pages-files");
  assert.deepEqual(await run(), [{ path: ".nojekyll", contents: "" }]);
});

test("a custom domain writes .nojekyll and CNAME with the bare host and one trailing newline", async () => {
  const files = await run(site({ url: "https://example.com" }));
  assert.deepEqual(paths(files), [".nojekyll", "CNAME"]);
  assert.equal(files[0]?.contents, "");
  assert.equal(files[1]?.contents, "example.com\n");
  assert.equal(cnameHost(site({ url: "https://example.com" })), "example.com");
});

test("a *.github.io site gets no CNAME, with or without a path, port, or mixed case", async () => {
  for (const url of [
    "https://arminazimi.github.io",
    "https://arminazimi.github.io/slipway",
    "https://arminazimi.github.io/slipway/",
    "https://ArmInAzimi.GitHub.io/",
    "http://example.github.io:8080/docs",
    "https://github.io",
  ]) {
    const files = await run(site({ url }));
    assert.deepEqual(paths(files), [".nojekyll"], url);
    assert.equal(cnameHost(site({ url })), undefined, url);
  }
});

test("a missing, empty, or invalid url gets no CNAME", async () => {
  for (const url of [undefined, "", "   ", "example.com", "not a url", "/relative", "//example.com"]) {
    const files = await run(site(url === undefined ? {} : { url }));
    assert.deepEqual(paths(files), [".nojekyll"], JSON.stringify(url));
    assert.equal(cnameHost(site(url === undefined ? {} : { url })), undefined, JSON.stringify(url));
  }
});

test("CNAME holds only the host: a port, path, query, fragment, and trailing root dot are dropped", async () => {
  const cases: Array<[string, string]> = [
    ["https://docs.example.com/slipway/", "docs.example.com"],
    ["https://example.com:8443/", "example.com"],
    ["https://example.com/?q=1#top", "example.com"],
    ["https://Example.COM", "example.com"],
    ["https://example.com.", "example.com"],
    ["https://www.example.com", "www.example.com"],
    ["https://münchen.example", "xn--mnchen-3ya.example"],
  ];
  for (const [url, host] of cases) {
    assert.equal(cnameHost(site({ url })), host, url);
    const files = await run(site({ url }));
    assert.deepEqual(paths(files), [".nojekyll", "CNAME"], url);
    assert.equal(files[1]?.contents, `${host}\n`, url);
  }
});

test("base does not change the CNAME, because it is a path on the same host", async () => {
  const files = await run(site({ url: "https://docs.example.com", base: "/slipway" }));
  assert.equal(files[1]?.contents, "docs.example.com\n");
});

test("a url that is not http(s) or whose host is not a DNS name gets no CNAME", async () => {
  for (const url of [
    "ftp://example.com",
    "mailto:docs@example.com",
    "http://localhost:3000",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://exa_mple.com",
    "https://example.com..",
  ]) {
    const files = await run(site({ url }));
    assert.deepEqual(paths(files), [".nojekyll"], url);
  }
});

test("the config's outputs map turns the output off by its name, which the pipeline reads", async () => {
  const model = site({ url: "https://example.com", outputs: { "pages-files": false } });
  assert.equal(pagesFiles.name, "pages-files");
  assert.equal(model.config.outputs[pagesFiles.name], false, "the pipeline looks the output up by this key");
  assert.deepEqual(paths(await run(model)), [".nojekyll", "CNAME"], "the output itself writes both files; the pipeline skips it");
});

test("two runs write the same files, sorted by code point", async () => {
  const model = site({ url: "https://docs.example.com" });
  const first = await run(model);
  const second = await run(model);
  assert.deepEqual(first, second);
  const returned = paths(first);
  assert.deepEqual(returned, [...returned].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test("CNAME is LF-only UTF-8 text ending in exactly one newline", async () => {
  const files = await run(site({ url: "https://docs.example.com" }));
  const contents = String(files[1]?.contents);
  assert.ok(!contents.includes("\r"), "no CR");
  assert.ok(contents.endsWith("\n") && !contents.endsWith("\n\n"), "exactly one trailing newline");
  assert.equal(contents, "docs.example.com\n");
});
