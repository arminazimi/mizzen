import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { resolveTitle } from "../src/content/title.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

/** Parses a source file the way the pipeline does and resolves its title. */
async function titleOf(source: string, file: string) {
  const fm = parseFrontMatter(source, file);
  const tree = await parseMarkdown(fm.body, fm.bodyLine);
  return resolveTitle({ frontMatter: fm.data, tree, file });
}

test("front matter title wins over the first h1 and the file name", async () => {
  const r = await titleOf("---\ntitle: From front matter\n---\n# From heading\n", "guide/install.md");
  assert.equal(r.title, "From front matter");
  // The body still has an h1, so the layout must not add a second one.
  assert.equal(r.titleFromBody, true);
});

test("without front matter the first h1 is the title and the layout skips its own h1", async () => {
  const r = await titleOf("# Install\n\ntext\n", "guide/install.md");
  assert.deepEqual(r, { title: "Install", titleFromBody: true });
});

test("only the first top-level h1 is used; h2 and later h1s are ignored", async () => {
  const r = await titleOf("## Sub\n\n# First\n\n# Second\n", "guide/install.md");
  assert.equal(r.title, "First");
  assert.equal(r.titleFromBody, true);
});

test("inline markup in the heading is dropped from the title", async () => {
  const r = await titleOf("# Install `beacon` on *Linux*\n", "guide/install.md");
  assert.equal(r.title, "Install beacon on Linux");
});

test("a page with no front matter and no h1 takes its file name without extension", async () => {
  const r = await titleOf("Just text.\n", "guide/install.md");
  assert.deepEqual(r, { title: "install", titleFromBody: false });
});

test("a blank front matter title falls back to the first h1", async () => {
  const r = await titleOf("---\ntitle: '   '\n---\n# Heading\n", "guide/install.md");
  assert.equal(r.title, "Heading");
});

test("a numeric front matter title is used as text", async () => {
  const r = await titleOf("---\ntitle: 2026\n---\ntext\n", "notes/2026.md");
  assert.equal(r.title, "2026");
  assert.equal(r.titleFromBody, false);
});

test("an empty h1 gives no title, so the file name is used", async () => {
  const r = await titleOf("#\n\ntext\n", "guide/install.md");
  assert.deepEqual(r, { title: "install", titleFromBody: true });
});

test("every page of fixtures/docs-site without front matter renders one h1", async () => {
  const site = fileURLToPath(new URL("../fixtures/docs-site/", import.meta.url));
  const docs = (await discover(site)).filter((f) => f.kind === "doc" && f.path.endsWith(".md"));
  let checked = 0;
  for (const doc of docs) {
    const source = await readFile(join(site, doc.path), "utf8");
    const fm = parseFrontMatter(source, doc.path);
    if (Object.keys(fm.data).length > 0) continue;
    checked++;

    const tree = await parseMarkdown(fm.body, fm.bodyLine);
    const resolved = resolveTitle({ frontMatter: fm.data, tree, file: doc.path });
    const { html } = await markdownToHtml(tree, doc.path);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;

    assert.equal(resolved.titleFromBody, true, `${doc.path} should take its title from its h1`);
    assert.equal(h1Count, 1, `${doc.path} should render exactly one h1`);
    assert.notEqual(resolved.title, "", doc.path);
  }
  assert.ok(checked > 10, `expected many pages without front matter, found ${checked}`);
});
