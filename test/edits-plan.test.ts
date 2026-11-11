import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Heading as MdHeading, Nodes } from "mdast";
import type { Site } from "../src/contracts/index.ts";
import { EditPlanError, planHeadingEdit } from "../src/edits/plan.ts";
import { applyPatch, hashSource, PatchError, sliceBySpan, type Patch } from "../src/edits/patch.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { buildModel } from "../src/model/build.ts";

/** Builds a throwaway site, reads its model, and removes the tree again. */
async function siteOf(files: Record<string, string>): Promise<Site> {
  const root = mkdtempSync(join(tmpdir(), "edits-plan-"));
  try {
    const all = "mizzen.yml" in files ? files : { "mizzen.yml": "title: T\n", ...files };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return (await buildModel(root)).site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The literal text a node renders with: text and code, not markup or breaks. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  let out = "";
  if ("children" in node) {
    for (const child of node.children) out += textOf(child);
  }
  return out;
}

/** A parsed page's headings in document order, as depth and plain text. */
async function headingTexts(markdown: string): Promise<{ depth: number; text: string }[]> {
  const tree = await parseMarkdown(markdown);
  return tree.children
    .filter((node): node is MdHeading => node.type === "heading")
    .map((heading) => ({ depth: heading.depth, text: textOf(heading) }));
}

test("plans a patch over an ATX heading's full span", async () => {
  const source = "# Guide\n\n## Install\n\nBody.\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  assert.equal(page.url, "/guide/");

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: "install", newText: "Set up" });
  assert.deepEqual(patch.span, { file: "guide.md", line: 3, column: 1, endLine: 3, endColumn: 10 });
  assert.equal(patch.expected, "## Install");
  assert.equal(patch.replacement, "## Set up");
  assert.equal(sliceBySpan(source, patch.span), patch.expected, "expected is the exact slice at the span");
  assert.equal(applyPatch(source, patch), "# Guide\n\n## Set up\n\nBody.\n");
});

test("keeps the old inline markup in expected and writes the new text plainly", async () => {
  const source = "## *Fast* start\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: "fast-start", newText: "Quick start" });
  assert.equal(patch.expected, "## *Fast* start");
  assert.equal(patch.replacement, "## Quick start");
  assert.deepEqual(await headingTexts(applyPatch(source, patch)), [{ depth: 2, text: "Quick start" }]);
});

test("duplicate heading text keeps its unique anchor ids, and only the named one changes", async () => {
  const source = "# Setup\n\n## Repeat\n\n## Repeat\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  assert.deepEqual(
    page.headings.map((heading) => heading.id),
    ["setup", "repeat", "repeat-1"],
  );

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: "repeat-1", newText: "Again" });
  assert.deepEqual(patch.span, { file: "guide.md", line: 5, column: 1, endLine: 5, endColumn: 9 });
  assert.equal(patch.expected, "## Repeat");
  assert.equal(applyPatch(source, patch), "# Setup\n\n## Repeat\n\n## Again\n");
  assert.deepEqual(await headingTexts(applyPatch(source, patch)), [
    { depth: 1, text: "Setup" },
    { depth: 2, text: "Repeat" },
    { depth: 2, text: "Again" },
  ]);
});

test("counts Persian columns as code points", async () => {
  const source = "# راهنما\n\n## شروع سریع\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  const heading = page.headings.find((candidate) => candidate.text === "شروع سریع");
  assert.ok(heading !== undefined);

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: heading.id, newText: "آغاز" });
  assert.deepEqual(patch.span, { file: "guide.md", line: 3, column: 1, endLine: 3, endColumn: 12 });
  assert.equal(patch.expected, "## شروع سریع");
  assert.equal(applyPatch(source, patch), "# راهنما\n\n## آغاز\n");
  assert.deepEqual(await headingTexts(applyPatch(source, patch)), [
    { depth: 1, text: "راهنما" },
    { depth: 2, text: "آغاز" },
  ]);
});

test("an astral character is one column, and the end is clamped to the line's real width", async () => {
  const source = "## Launch 🌍 now\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  const heading = page.headings[0]!;
  assert.equal(heading.id, "launch--now");

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: heading.id, newText: "Launch 🌕 later" });
  // "## Launch 🌍 now" is 15 code points; remark's UTF-16 column would say 16.
  assert.deepEqual(patch.span, { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 15 });
  assert.equal(patch.expected, "## Launch 🌍 now");
  assert.equal(sliceBySpan(source, patch.span), patch.expected);
  assert.equal(applyPatch(source, patch), "## Launch 🌕 later\n");
  assert.deepEqual(await headingTexts(applyPatch(source, patch)), [{ depth: 2, text: "Launch 🌕 later" }]);
});

test("a rendered heading that is not in the page's source headings is a generated target", async () => {
  const source = "# Title\n\n<h2 id=\"generated\">Generated</h2>\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  assert.equal(page.url, "/guide/");

  assert.throws(
    () => planHeadingEdit({ site, source, url: page.url, headingId: "generated", newText: "Changed" }),
    (error: unknown) => {
      assert.ok(error instanceof EditPlanError);
      assert.equal(error.name, "EditPlanError");
      assert.equal(error.code, "edit.generated-target");
      assert.equal(error.url, "/guide/");
      assert.equal(error.headingId, "generated");
      assert.match(error.message, /generated content/);
      return true;
    },
  );
});

test("a heading on an app page is a generated target too", async () => {
  const site = await siteOf({ "dashboard/index.html": "<h1 id=\"welcome\">Welcome</h1>\n" });
  const page = site.pages.find((candidate) => candidate.url === "/dashboard/");
  assert.ok(page !== undefined);
  assert.equal(page.kind, "app");

  assert.throws(
    () => planHeadingEdit({ site, source: "", url: page.url, headingId: "welcome", newText: "Hello" }),
    (error: unknown) => error instanceof EditPlanError && error.code === "edit.generated-target",
  );
});

test("an unknown page is an unknown-page error", async () => {
  const site = await siteOf({ "guide.md": "# Guide\n" });
  assert.throws(
    () => planHeadingEdit({ site, source: "# Guide\n", url: "/missing/", headingId: "guide", newText: "X" }),
    (error: unknown) => error instanceof EditPlanError && error.code === "edit.unknown-page",
  );
});

test("source text that does not hold the heading is a source-mismatch error", async () => {
  const source = "# Guide\n\n## Install\n";
  const site = await siteOf({ "guide.md": source, "other.md": "Different\n" });
  assert.throws(
    () =>
      planHeadingEdit({
        site,
        source: "Different\nlines\nhere\n",
        url: "/guide/",
        headingId: "install",
        newText: "Set up",
      }),
    (error: unknown) => {
      assert.ok(error instanceof EditPlanError);
      assert.equal(error.code, "edit.source-mismatch");
      assert.ok(error.span !== undefined);
      assert.equal(error.span.line, 3);
      return true;
    },
  );
});

test("a setext heading is planned as an ATX heading and leaves the following line in place", async () => {
  const source = "Title\n=====\n\nBody.\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  const heading = page.headings[0]!;
  assert.equal(heading.depth, 1);

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: heading.id, newText: "New title" });
  assert.equal(patch.expected, "Title\n=====");
  assert.equal(patch.replacement, "# New title");
  const patched = applyPatch(source, patch);
  assert.equal(patched, "# New title\n\nBody.\n");
  assert.deepEqual(await headingTexts(patched), [{ depth: 1, text: "New title" }]);
});

test("the planned patch carries the source hash, so a changed source is refused before the span is touched", async () => {
  const source = "# Guide\n\n## Install\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;

  const patch = planHeadingEdit({ site, source, url: page.url, headingId: "install", newText: "Set up" });
  assert.equal(patch.beforeHash, hashSource(source));

  const changed = "# Guide\n\n## Install\n\nA new paragraph changed the file.\n";
  assert.throws(
    () => applyPatch(changed, patch),
    (error: unknown) => error instanceof PatchError && error.code === "hash-mismatch",
  );
});

test("a heading id that names two source headings is an ambiguous target", async () => {
  const source = "# Guide\n\n## Install\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  const ambiguous: Site = {
    ...site,
    pages: [{ ...page, headings: [...page.headings, page.headings[1]!] }],
  };

  assert.throws(
    () => planHeadingEdit({ site: ambiguous, source, url: page.url, headingId: "install", newText: "Set up" }),
    (error: unknown) => {
      assert.ok(error instanceof EditPlanError);
      assert.equal(error.code, "edit.ambiguous-target");
      assert.equal(error.headingId, "install");
      return true;
    },
  );
});

test("the same request gives the same patch", async () => {
  const source = "# Guide\n\n## Install\n";
  const site = await siteOf({ "guide.md": source });
  const page = site.pages[0]!;
  const request = { site, source, url: page.url, headingId: "install", newText: "Set up" };
  const first: Patch = planHeadingEdit(request);
  assert.deepEqual(planHeadingEdit(request), first);
});
