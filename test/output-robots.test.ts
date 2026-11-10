import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { Site } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { robots, robotsText, sitemapUrl } from "../src/outputs/robots.ts";

function site(url: string | undefined, base: string): Site {
  return {
    config: {
      title: "Example",
      ...(url === undefined ? {} : { url }),
      base,
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
    },
    pages: [],
    nav: {},
    data: {},
  };
}

/** A context that keeps every diagnostic reported to it, so a test can read them back. */
function recordingContext(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("robots never renders a page")),
    report: (d) => {
      reported.push(d);
    },
  };
  return { ctx, reported };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; reported: Diagnostic[] }> {
  const { ctx, reported } = recordingContext();
  const files = await robots.run(model, ctx);
  return { files, reported };
}

test("robots.txt allows every path and names the sitemap at the site root", async () => {
  const { files, reported } = await run(site("https://example.com", ""));
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "robots.txt");
  assert.equal(files[0]?.contents, "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n");
  assert.deepEqual(reported, [], "a site with a url reports nothing");
});

test("the Sitemap line carries the base, so a project site under /evergreen names /evergreen/sitemap.xml", async () => {
  const sitemap = "https://example.github.io/evergreen/sitemap.xml";
  assert.equal(sitemapUrl(site("https://example.github.io", "/evergreen")), sitemap);
  const { files } = await run(site("https://example.github.io", "/evergreen"));
  assert.equal(files[0]?.contents, robotsText(sitemap));
  assert.ok(String(files[0]?.contents).includes(`\nSitemap: ${sitemap}\n`));
});

test("a url with a trailing slash does not put a double slash in the sitemap address", () => {
  assert.equal(sitemapUrl(site("https://example.com/", "")), "https://example.com/sitemap.xml");
  assert.equal(sitemapUrl(site("https://example.com//", "/docs")), "https://example.com/docs/sitemap.xml");
});

test("without a url the file is still written, with no Sitemap line, and a warning says how to add one", async () => {
  assert.equal(sitemapUrl(site(undefined, "")), undefined);
  const { files, reported } = await run(site(undefined, ""));
  assert.equal(files[0]?.contents, "User-agent: *\nAllow: /\n");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "robots.no-sitemap");
  assert.equal(reported[0]?.severity, "warning");
  assert.ok(reported[0]?.help?.includes("`url`"));
});

test("an empty url counts as no url", () => {
  assert.equal(sitemapUrl(site("", "")), undefined);
});

test("robots.txt is LF-only UTF-8 text ending in one newline", async () => {
  const { files } = await run(site("https://example.com", ""));
  const contents = String(files[0]?.contents);
  assert.ok(!contents.includes("\r"), "no CR");
  assert.ok(contents.endsWith("\n") && !contents.endsWith("\n\n"), "exactly one trailing newline");
});

test("the output is named robots and writes one file, robots.txt", () => {
  assert.equal(robots.name, "robots");
});
