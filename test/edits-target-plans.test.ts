import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Site } from "../src/contracts/index.ts";
import { planHeadingEdit } from "../src/edits/plan.ts";
import {
  applyPatch,
  hashSource,
  PatchError,
  sliceBySpan,
  writeFilePatches,
  type Patch,
  type PatchSpan,
} from "../src/edits/patch.ts";
import { planCodeFenceEdit, planLinkEdit, TargetPlanError } from "../src/edits/target-plans.ts";
import { buildModel } from "../src/model/build.ts";

/** Writes a throwaway site, reads its model, and removes the tree again. */
async function siteOf(files: Record<string, string>): Promise<Site> {
  const root = mkdtempSync(join(tmpdir(), "edits-target-plans-"));
  try {
    writeSite(root, files);
    return (await buildModel(root)).site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Writes a throwaway site and leaves it for the caller to remove. */
async function keptSite(files: Record<string, string>): Promise<{ site: Site; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "edits-target-plans-"));
  writeSite(root, files);
  return { site: (await buildModel(root)).site, root };
}

function writeSite(root: string, files: Record<string, string>): void {
  const all = "mizzen.yml" in files ? files : { "mizzen.yml": "title: T\n", ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A source span in the page the tests build, `guide.md`. */
function span(line: number, column: number, endLine: number, endColumn: number): PatchSpan {
  return { file: "guide.md", line, column, endLine, endColumn };
}

/** The error a refusal must be, by code. */
function refused(code: TargetPlanError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof TargetPlanError, `expected a TargetPlanError, got ${String(error)}`);
    assert.equal(error.name, "TargetPlanError");
    assert.equal(error.code, code);
    return true;
  };
}

test("plans an inline link's destination and keeps its angle brackets and title", async () => {
  const source = 'See [Install](<../install.md> "Guide") now.\n';
  const site = await siteOf({ "guide.md": source });
  const url = site.pages[0]!.url;

  const patch = planLinkEdit({
    site,
    source,
    url,
    target: span(1, 5, 1, 38),
    newDestination: "/docs/",
  });
  assert.deepEqual(patch.span, span(1, 16, 1, 28));
  assert.equal(patch.expected, "../install.md");
  assert.equal(patch.replacement, "/docs/");
  assert.equal(patch.beforeHash, hashSource(source));
  assert.equal(sliceBySpan(source, patch.span), patch.expected);
  assert.equal(
    applyPatch(source, patch, { requireExpected: true, requireHash: true }),
    'See [Install](</docs/> "Guide") now.\n',
  );
});

test("a plain inline link changes only its destination", async () => {
  const source = "See [Install](../install.md) now.\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planLinkEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 5, 1, 28),
    newDestination: "/docs/install/",
  });
  assert.deepEqual(patch.span, span(1, 15, 1, 27));
  assert.equal(applyPatch(source, patch), "See [Install](/docs/install/) now.\n");
});

test("front matter moves the link and its span into the full source", async () => {
  const source = "---\ntitle: Guide\n---\n\nSee [Install](../install.md).\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planLinkEdit({
    site,
    source,
    url: "/guide/",
    target: span(5, 5, 5, 28),
    newDestination: "/docs/",
  });
  assert.deepEqual(patch.span, span(5, 15, 5, 27));
  assert.equal(patch.expected, "../install.md");
  assert.equal(
    applyPatch(source, patch, { requireExpected: true, requireHash: true }),
    "---\ntitle: Guide\n---\n\nSee [Install](/docs/).\n",
  );
});

test("a reference link resolves through its one definition and keeps the label and title", async () => {
  const source = 'See [Install][docs].\n\n[docs]: ../install.md "Guide"\n';
  const site = await siteOf({ "guide.md": source });
  const usage = planLinkEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 5, 1, 19),
    newDestination: "/install/",
  });
  const definition = planLinkEdit({
    site,
    source,
    url: "/guide/",
    target: span(3, 1, 3, 29),
    newDestination: "/install/",
  });

  assert.deepEqual(usage, definition);
  assert.deepEqual(usage.span, span(3, 9, 3, 21));
  assert.equal(usage.expected, "../install.md");
  assert.equal(
    applyPatch(source, usage),
    'See [Install][docs].\n\n[docs]: /install/ "Guide"\n',
  );
});

test("plans a tilde fence's body and leaves markers, info string, and whitespace alone", async () => {
  const source = '~~~ts title="start"\nconst a = 1;\n~~~\n';
  const site = await siteOf({ "guide.md": source });
  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 1, 3, 3),
    newBody: "const b = 2;",
  });
  assert.deepEqual(patch.span, span(2, 1, 2, 12));
  assert.equal(patch.expected, "const a = 1;");
  assert.equal(patch.replacement, "const b = 2;");
  assert.equal(patch.beforeHash, hashSource(source));
  assert.equal(
    applyPatch(source, patch, { requireExpected: true, requireHash: true }),
    '~~~ts title="start"\nconst b = 2;\n~~~\n',
  );
});

test("a longer backtick fence keeps its marker length and info string", async () => {
  const source = "````md\n# Title\n````\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 1, 3, 4),
    newBody: "# New title",
  });
  assert.deepEqual(patch.span, span(2, 1, 2, 7));
  assert.equal(applyPatch(source, patch), "````md\n# New title\n````\n");
});

test("an indented fence keeps its indentation on every new line", async () => {
  const source = "   ```ts\n   let a = 1;\n   ```\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 4, 3, 6),
    newBody: "let a = 1;\nlet b = 2;",
  });
  assert.deepEqual(patch.span, span(2, 1, 2, 13));
  assert.equal(patch.expected, "   let a = 1;");
  assert.equal(patch.replacement, "   let a = 1;\n   let b = 2;");
  assert.equal(
    applyPatch(source, patch),
    "   ```ts\n   let a = 1;\n   let b = 2;\n   ```\n",
  );
});

test("an empty fence gains a body between its unchanged still fence lines", async () => {
  const source = "```ts\n```\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 1, 2, 3),
    newBody: "const x = 1;",
  });
  assert.equal(patch.expected, "`", "the insertion carries the first closing character");
  assert.equal(patch.replacement, "const x = 1;\n`");
  assert.equal(applyPatch(source, patch), "```ts\nconst x = 1;\n```\n");
});

test("an indented code block's contents can be planned too", async () => {
  const source = "    let a = 1;\n    let b = 2;\n";
  const site = await siteOf({ "guide.md": source });
  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 1, 2, 14),
    newBody: "let c = 3;",
  });
  assert.equal(patch.expected, "    let a = 1;\n    let b = 2;");
  assert.equal(patch.replacement, "    let c = 3;");
  assert.equal(applyPatch(source, patch), "    let c = 3;\n");
});

test("Unicode columns count code points for a link and a fence", async () => {
  const linkSource = "[🚀 Launch](https://example.com/a) now\n";
  const linkSite = await siteOf({ "guide.md": linkSource });
  const linkPatch = planLinkEdit({
    site: linkSite,
    source: linkSource,
    url: "/guide/",
    target: span(1, 1, 1, 33),
    newDestination: "https://example.org/b",
  });
  assert.deepEqual(linkPatch.span, span(1, 12, 1, 32));
  assert.equal(
    applyPatch(linkSource, linkPatch),
    "[🚀 Launch](https://example.org/b) now\n",
  );

  const fenceSource = '```\nconst greet = "سلام 🌍";\n```\n';
  const fenceSite = await siteOf({ "guide.md": fenceSource });
  const fencePatch = planCodeFenceEdit({
    site: fenceSite,
    source: fenceSource,
    url: "/guide/",
    target: span(1, 1, 3, 3),
    newBody: 'const greet = "hello";',
  });
  assert.deepEqual(fencePatch.span, span(2, 1, 2, 23));
  assert.equal(fencePatch.expected, 'const greet = "سلام 🌍";');
  assert.equal(applyPatch(fenceSource, fencePatch), '```\nconst greet = "hello";\n```\n');
});

test("CRLF line endings survive both a link and a fence edit", async () => {
  const source = "See [A](old.md).\r\n\r\n```ts\r\nconst a = 1;\r\n```\r\n";
  const site = await siteOf({ "guide.md": source });

  const linkPatch = planLinkEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 5, 1, 15),
    newDestination: "new.md",
  });
  assert.deepEqual(linkPatch.span, span(1, 9, 1, 14));
  const linked = applyPatch(source, linkPatch);
  assert.equal(linked, "See [A](new.md).\r\n\r\n```ts\r\nconst a = 1;\r\n```\r\n");
  assert.equal((linked.match(/\r\n/g) ?? []).length, (source.match(/\r\n/g) ?? []).length);
  assert.equal(linked.replace(/\r\n/g, "").includes("\n"), false, "no line ending became a lone LF");

  const fencePatch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(3, 1, 5, 3),
    newBody: "const b = 2;",
  });
  assert.deepEqual(fencePatch.span, span(4, 1, 4, 12));
  const fenced = applyPatch(source, fencePatch);
  assert.equal(fenced, "See [A](old.md).\r\n\r\n```ts\r\nconst b = 2;\r\n```\r\n");
  assert.equal((fenced.match(/\r\n/g) ?? []).length, (source.match(/\r\n/g) ?? []).length);
});

test("a CRLF source keeps CRLF across a multi-line body and an empty fence", async () => {
  const source = "```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n";
  const site = await siteOf({ "guide.md": source });

  const patch = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(1, 1, 4, 3),
    newBody: "const c = 3;\nconst d = 4;",
  });
  assert.equal(patch.replacement, "const c = 3;\r\nconst d = 4;");
  const replaced = applyPatch(source, patch);
  assert.equal(replaced, "```ts\r\nconst c = 3;\r\nconst d = 4;\r\n```\r\n");
  assert.equal(replaced.replace(/\r\n/g, "").includes("\n"), false, "no line ending became a lone LF");

  const emptySource = "```ts\r\n```\r\n";
  const emptySite = await siteOf({ "guide.md": emptySource });
  const inserted = applyPatch(
    emptySource,
    planCodeFenceEdit({
      site: emptySite,
      source: emptySource,
      url: "/guide/",
      target: span(1, 1, 2, 3),
      newBody: "const x = 1;\nconst y = 2;",
    }),
  );
  assert.equal(inserted, "```ts\r\nconst x = 1;\r\nconst y = 2;\r\n```\r\n");
  assert.equal(inserted.replace(/\r\n/g, "").includes("\n"), false, "no inserted line is a lone LF");
});

test("a reference link with two matching definitions is an ambiguous target", async () => {
  const source = "[Install][docs]\n\n[docs]: ../a.md\n[docs]: ../b.md\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source,
        url: "/guide/",
        target: span(1, 1, 1, 15),
        newDestination: "/c/",
      }),
    refused("edit.ambiguous-target"),
  );
});

test("a raw HTML anchor is a generated target", async () => {
  const source = '<a href="/x">x</a>\n';
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source,
        url: "/guide/",
        target: span(1, 1, 1, 13),
        newDestination: "/y",
      }),
    refused("edit.generated-target"),
  );
  assert.throws(
    () =>
      planCodeFenceEdit({
        site,
        source,
        url: "/guide/",
        target: span(1, 1, 1, 13),
        newBody: "x",
      }),
    refused("edit.generated-target"),
  );
});

test("an app page is generated content for both planners", async () => {
  const site = await siteOf({ "dashboard/index.html": "<h1 id=\"welcome\">Welcome</h1>\n" });
  const url = site.pages.find((page) => page.kind === "app")!.url;
  assert.throws(
    () => planLinkEdit({ site, source: "", url, target: span(1, 1, 1, 1), newDestination: "/x" }),
    refused("edit.generated-target"),
  );
  assert.throws(
    () => planCodeFenceEdit({ site, source: "", url, target: span(1, 1, 1, 1), newBody: "x" }),
    refused("edit.generated-target"),
  );
});

test("a target outside the source is an out-of-range refusal", async () => {
  const source = "# Guide\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source,
        url: "/guide/",
        target: span(5, 1, 5, 1),
        newDestination: "/x",
      }),
    refused("edit.out-of-range"),
  );
  assert.throws(
    () =>
      planCodeFenceEdit({
        site,
        source,
        url: "/guide/",
        target: span(5, 1, 5, 1),
        newBody: "x",
      }),
    refused("edit.out-of-range"),
  );
});

test("a target that names only part of a link is a source mismatch", async () => {
  const source = "See [Install](../install.md) now.\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source,
        url: "/guide/",
        target: span(1, 5, 1, 13),
        newDestination: "/x",
      }),
    refused("edit.source-mismatch"),
  );
});

test("source text from another page is a source mismatch", async () => {
  const source = "See [Install](../install.md) now.\n";
  const site = await siteOf({ "guide.md": source, "other.md": "Completely different text here.\n" });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source: "Completely different text here.\n",
        url: "/guide/",
        target: span(1, 5, 1, 28),
        newDestination: "/x",
      }),
    refused("edit.source-mismatch"),
  );
});

test("a target that names another source file is a source mismatch", async () => {
  const source = "See [Install](../install.md) now.\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planLinkEdit({
        site,
        source,
        url: "/guide/",
        target: { file: "other.md", line: 1, column: 5, endLine: 1, endColumn: 28 },
        newDestination: "/x",
      }),
    refused("edit.source-mismatch"),
  );
});

test("the planned patch passes the strict stale-patch checks and the strict writer", async () => {
  const source = "See [Install](../install.md) now.\n";
  const { site, root } = await keptSite({ "guide.md": source });
  try {
    const patch = planLinkEdit({
      site,
      source,
      url: "/guide/",
      target: span(1, 5, 1, 28),
      newDestination: "/docs/install/",
    });
    const changed = "See [Install](../install.md) now.\n\nA new paragraph changed the file.\n";
    assert.throws(
      () => applyPatch(changed, patch, { requireExpected: true, requireHash: true }),
      (error: unknown) => error instanceof PatchError && error.code === "hash-mismatch",
    );

    const results = await writeFilePatches(root, [{ file: "guide.md", patches: [patch] }]);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.before, source);
    assert.equal(results[0]!.after, "See [Install](/docs/install/) now.\n");
    assert.equal(readFileSync(join(root, "guide.md"), "utf8"), results[0]!.after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heading planning still produces the same patch", async () => {
  const source = "# Guide\n\n## Install\n";
  const site = await siteOf({ "guide.md": source });
  const patch: Patch = planHeadingEdit({
    site,
    source,
    url: "/guide/",
    headingId: "install",
    newText: "Set up",
  });
  assert.deepEqual(patch, {
    span: span(3, 1, 3, 10),
    expected: "## Install",
    replacement: "## Set up",
    beforeHash: hashSource(source),
  });
});
