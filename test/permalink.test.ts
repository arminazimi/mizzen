import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { permalink } from "../src/content/permalink.ts";

test("a/b.md becomes /a/b/; index.md and README.md become the folder URL", () => {
  assert.equal(permalink("a/b.md"), "/a/b/");
  assert.equal(permalink("a/index.md"), "/a/");
  assert.equal(permalink("a/README.md"), "/a/");
  assert.equal(permalink("index.md"), "/");
  assert.equal(permalink("README.md"), "/");
  assert.equal(permalink("guide/install.md"), "/guide/install/");
  assert.equal(permalink("guide/install/index.md"), "/guide/install/");
  assert.equal(permalink("about.html"), "/about/");
  assert.equal(permalink("docs/rules/README.md"), "/docs/rules/");
});

test("front matter permalink wins over the path", () => {
  assert.equal(permalink("404.md", { permalink: "/404.html" }), "/404.html");
  assert.equal(permalink("old.md", { permalink: "/new/place/" }), "/new/place/");
  assert.equal(permalink("x.md", { permalink: "custom/" }), "/custom/");
});

test("base path prefixes every URL for sites in a subpath", () => {
  assert.equal(permalink("a/b.md", { base: "/docs" }), "/docs/a/b/");
  assert.equal(permalink("index.md", { base: "/docs" }), "/docs/");
  assert.equal(permalink("a/index.md", { base: "/docs" }), "/docs/a/");
  assert.equal(permalink("404.md", { base: "/docs", permalink: "/404.html" }), "/docs/404.html");
  assert.equal(permalink("a/b.md", { base: "" }), "/a/b/");
});

/** Collect Markdown files under `dir`, relative to `root`, using `/` separators. */
function markdownFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      out.push(...markdownFiles(root, rel));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test("the URL table of examples/product-docs matches the pretty-URL rules", () => {
  const root = fileURLToPath(new URL("../fixtures/product-docs", import.meta.url));
  // Pretty-URL table for the product-docs pages; 404 keeps its front matter permalink.
  const expected: Record<string, string> = {
    "404.md": "/404.html",
    "ci.md": "/ci/",
    "commands.md": "/commands/",
    "configuration.md": "/configuration/",
    "faq.md": "/faq/",
    "index.md": "/",
    "install.md": "/install/",
    "output.md": "/output/",
    "quickstart.md": "/quickstart/",
    "reference/build.md": "/reference/build/",
    "reference/cache-clear.md": "/reference/cache-clear/",
    "reference/cache-ls.md": "/reference/cache-ls/",
    "reference/completion.md": "/reference/completion/",
    "reference/config-path.md": "/reference/config-path/",
    "reference/config-set.md": "/reference/config-set/",
    "reference/config-show.md": "/reference/config-show/",
    "reference/deploy.md": "/reference/deploy/",
    "reference/diff.md": "/reference/diff/",
    "reference/doctor.md": "/reference/doctor/",
    "reference/env.md": "/reference/env/",
    "reference/help.md": "/reference/help/",
    "reference/hook-ls.md": "/reference/hook-ls/",
    "reference/hook-run.md": "/reference/hook-run/",
    "reference/index.md": "/reference/",
    "reference/init.md": "/reference/init/",
    "reference/login.md": "/reference/login/",
    "reference/logout.md": "/reference/logout/",
    "reference/logs.md": "/reference/logs/",
    "reference/purge.md": "/reference/purge/",
    "reference/releases.md": "/reference/releases/",
    "reference/rollback.md": "/reference/rollback/",
    "reference/secret-ls.md": "/reference/secret-ls/",
    "reference/secret-rm.md": "/reference/secret-rm/",
    "reference/secret-set.md": "/reference/secret-set/",
    "reference/size.md": "/reference/size/",
    "reference/status.md": "/reference/status/",
    "reference/targets.md": "/reference/targets/",
    "reference/validate.md": "/reference/validate/",
    "reference/version.md": "/reference/version/",
    "security.md": "/security/",
    "troubleshooting.md": "/troubleshooting/",
  };

  const files = markdownFiles(root);
  assert.deepEqual(files, Object.keys(expected));

  const actual: Record<string, string> = {};
  for (const path of files) {
    const { data } = parseFrontMatter(readFileSync(join(root, path), "utf8"), path);
    const fm = typeof data.permalink === "string" ? data.permalink : undefined;
    actual[path] = permalink(path, fm === undefined ? {} : { permalink: fm });
  }
  assert.deepEqual(actual, expected);
});
