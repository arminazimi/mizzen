import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { expandIncludes, type ExpandIncludesOptions } from "../src/content/includes.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "includes-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Expands `body` of `file` under `root`, with the defaults the engine's build uses. */
function expand(root: string, file: string, body: string, extra: Partial<ExpandIncludesOptions> = {}) {
  return expandIncludes({ body, bodyLine: 1, file, sourceDir: root, ...extra });
}

test("a plain include splices the file's text in place of the directive line", async () => {
  const root = tree({ "snippets/note.md": "Included text.\n" });
  try {
    const result = await expand(root, "intro.md", "Before\n\n::include[snippets/note.md]\n\nAfter\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "Before\n\nIncluded text.\n\nAfter\n");
    assert.equal(result.bodyLine, 1);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("lines keeps a 1-based inclusive range, in either directive form", async () => {
  const root = tree({ "snippets/note.md": "one\ntwo\nthree\nfour\n" });
  try {
    const label = await expand(root, "a.md", "::include[snippets/note.md]{lines=2-3}\n");
    assert.deepEqual(label.diagnostics, []);
    assert.equal(label.body, "two\nthree\n");

    const attribute = await expand(root, "a.md", '::include{path="snippets/note.md" lines="2-3"}\n');
    assert.deepEqual(attribute.diagnostics, []);
    assert.equal(attribute.body, "two\nthree\n");

    const one = await expand(root, "a.md", "::include[snippets/note.md]{lines=4}\n");
    assert.equal(one.body, "four\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a path is relative to the file that holds the directive, and a nested include to that file", async () => {
  const root = tree({
    "guide/intro.md": "::include[snippets/one.md]\n",
    "guide/snippets/one.md": "One.\n\n::include[../shared/two.md]\n",
    "guide/shared/two.md": "Two.\n",
  });
  try {
    const result = await expand(root, "guide/intro.md", "::include[snippets/one.md]\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "One.\n\nTwo.\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a cycle is reported with its chain and the rest of the body still expands", async () => {
  const root = tree({
    "a.md": "",
    "b.md": "B before\n::include[a.md]\nB after\n",
  });
  try {
    const result = await expand(root, "a.md", "A\n::include[b.md]\nDone\n");
    const cycle = result.diagnostics.filter((d) => d.id === "include.cycle");
    assert.equal(cycle.length, 1);
    assert.equal(cycle[0]!.severity, "error");
    assert.match(cycle[0]!.message, /a\.md → b\.md → a\.md/);
    assert.equal(cycle[0]!.pos?.file, "b.md");
    assert.equal(cycle[0]!.pos?.line, 2);
    assert.equal(result.body, "A\nB before\nB after\nDone\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a file that includes itself is a cycle", async () => {
  const root = tree({});
  try {
    const result = await expand(root, "a.md", "::include[a.md]\n");
    assert.equal(result.diagnostics[0]?.id, "include.cycle");
    assert.equal(result.body, "");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a missing file is a diagnostic at the directive's page line, and the line is dropped", async () => {
  const root = tree({});
  try {
    const result = await expand(root, "guide/a.md", "intro\n\n::include[nope.md]\nafter\n");
    const d = result.diagnostics[0]!;
    assert.equal(d.id, "include.missing");
    assert.equal(d.severity, "error");
    assert.equal(d.pos?.file, "guide/a.md");
    assert.equal(d.pos?.line, 3);
    assert.equal(d.pos?.column, 1);
    assert.equal(result.body, "intro\n\nafter\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("front matter in an included file is stripped and its values ignored", async () => {
  const root = tree({ "s.md": "---\ntitle: Snippet\norder: 3\n---\nBody text.\n" });
  try {
    const result = await expand(root, "a.md", "::include[s.md]\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "Body text.\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an include may not leave the source folder, by any spelling", async () => {
  const root = tree({ "source/a.md": "", "secret.md": "secret\n" });
  const sourceDir = join(root, "source");
  try {
    for (const path of ["../secret.md", join(root, "secret.md")]) {
      const result = await expand(sourceDir, "a.md", `::include[${path}]\n`);
      assert.equal(result.diagnostics[0]?.id, "include.outside-source", path);
      assert.equal(result.diagnostics[0]?.pos?.file, "a.md");
      assert.equal(result.body, "");
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the body keeps its starting line, and diagnostics count from it", async () => {
  const root = tree({});
  try {
    const result = await expand(root, "a.md", "text\n\n::include[nope.md]\n", { bodyLine: 4 });
    assert.equal(result.bodyLine, 4);
    assert.equal(result.diagnostics[0]?.pos?.line, 6);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a slice outside the file is a diagnostic and the directive line is dropped", async () => {
  const root = tree({ "s.md": "one\ntwo\n" });
  try {
    const result = await expand(root, "a.md", "before\n::include[s.md]{lines=2-9}\nafter\n");
    assert.equal(result.diagnostics[0]?.id, "include.lines-out-of-range");
    assert.equal(result.diagnostics[0]?.pos?.line, 2);
    assert.equal(result.body, "before\nafter\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a lines value that is not a range is a diagnostic", async () => {
  const root = tree({ "s.md": "one\n" });
  try {
    const result = await expand(root, "a.md", "::include[s.md]{lines=two}\n");
    assert.equal(result.diagnostics[0]?.id, "include.invalid-lines");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a directive without a path is a diagnostic", async () => {
  const root = tree({});
  try {
    const result = await expand(root, "a.md", "::include\n");
    assert.equal(result.diagnostics[0]?.id, "include.no-path");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a directive inside a fenced code block is an example, not an include", async () => {
  const root = tree({ "s.md": "included\n" });
  try {
    const source = "```md\n::include[s.md]\n```\n\n~~~\n::include[s.md]\n~~~\n";
    const result = await expand(root, "a.md", source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, source);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("nesting past maxDepth is a diagnostic", async () => {
  const root = tree({
    "a.md": "::include[b.md]\n",
    "b.md": "::include[c.md]\n",
    "c.md": "deep\n",
  });
  try {
    const result = await expand(root, "a.md", "::include[b.md]\n", { maxDepth: 1 });
    assert.equal(result.diagnostics[0]?.id, "include.too-deep");
    assert.equal(result.diagnostics[0]?.pos?.file, "b.md");
    assert.equal(result.body, "");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a path that is a folder cannot be read and says so", async () => {
  const root = tree({ "folder/keep.md": "x\n" });
  try {
    const result = await expand(root, "a.md", "::include[folder]\n");
    assert.equal(result.diagnostics[0]?.id, "include.unreadable");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a page built by the model carries the included text, and a missing include names the page", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "snippets/note.md": "Shared sentence.\n",
    "guide/with.md": "---\ntitle: With\n---\nintro\n\n::include[../snippets/note.md]\n",
    "guide/without.md": "---\ntitle: Without\n---\nintro\n\n::include[missing.md]\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    const page = site.pages.find((p) => p.url === "/guide/with/")!;
    assert.equal(page.markdown, "intro\n\nShared sentence.\n");
    assert.match(page.html, /Shared sentence\./);

    const missing = diagnostics.filter((d) => d.id === "include.missing");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.pos?.file, "guide/without.md");
    assert.equal(missing[0]!.pos?.line, 6);
  } finally {
    rmSync(root, { recursive: true });
  }
});
