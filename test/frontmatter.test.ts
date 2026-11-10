import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontMatter } from "../src/content/frontmatter.ts";

const F = "docs/a.md";

/** The 1-based line of `needle` in `source`. */
function lineOf(source: string, needle: string): number {
  return source.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

test("without front matter the body is the whole file starting at line 1", () => {
  const src = "# Title\n\ntext\n";
  const r = parseFrontMatter(src, F);
  assert.deepEqual(r.data, {});
  assert.equal(r.body, src);
  assert.equal(r.bodyLine, 1);
  assert.deepEqual(r.diagnostics, []);
});

test("with front matter the body starts on the right line", () => {
  const src = "---\ntitle: Hi\ntags: [a, b]\n---\n# Heading\n\ntext\n";
  const r = parseFrontMatter(src, F);
  assert.deepEqual(r.data, { title: "Hi", tags: ["a", "b"] });
  assert.equal(r.body, "# Heading\n\ntext\n");
  assert.equal(r.bodyLine, lineOf(src, "# Heading"));
  assert.equal(r.bodyLine, 5);
});

test("body line N maps back to the same text in the source", () => {
  const src = "---\na: 1\nb: 2\n---\n\nfirst\nsecond\n";
  const r = parseFrontMatter(src, F);
  const sourceLines = src.split("\n");
  const bodyLines = r.body.split("\n");
  for (let i = 0; i < bodyLines.length; i++) {
    assert.equal(sourceLines[r.bodyLine - 1 + i], bodyLines[i]);
  }
});

test("CRLF files keep their line endings and positions", () => {
  const src = "---\r\ntitle: Hi\r\n---\r\nbody\r\n";
  const r = parseFrontMatter(src, F);
  assert.deepEqual(r.data, { title: "Hi" });
  assert.equal(r.body, "body\r\n");
  assert.equal(r.bodyLine, 4);
});

test("a byte order mark is ignored", () => {
  const r = parseFrontMatter("﻿---\ntitle: Hi\n---\nbody", F);
  assert.deepEqual(r.data, { title: "Hi" });
  assert.equal(r.bodyLine, 4);
});

test("empty front matter gives empty data", () => {
  const r = parseFrontMatter("---\n---\nbody\n", F);
  assert.deepEqual(r.data, {});
  assert.equal(r.bodyLine, 3);
  assert.deepEqual(r.diagnostics, []);
});

test("a --- later in the body is not front matter", () => {
  const src = "# Title\n\n---\nnot: yaml\n---\n";
  const r = parseFrontMatter(src, F);
  assert.equal(r.body, src);
  assert.equal(r.bodyLine, 1);
});

test("invalid YAML is a diagnostic with its line in the file", () => {
  const src = "---\ntitle: ok\nbad: [unclosed\nother: 1\n---\nbody\n";
  const r = parseFrontMatter(src, F);
  assert.deepEqual(r.data, {});
  assert.ok(r.diagnostics.length > 0);
  const d = r.diagnostics[0]!;
  assert.equal(d.id, "frontmatter.invalid-yaml");
  assert.equal(d.severity, "error");
  assert.equal(d.pos?.file, F);
  assert.ok(d.pos!.line >= 3 && d.pos!.line <= 5, `line ${d.pos!.line}`);
  assert.equal(r.bodyLine, 6);
});

test("an unclosed fence is a diagnostic", () => {
  const r = parseFrontMatter("---\ntitle: Hi\nbody\n", F);
  assert.equal(r.diagnostics[0]?.id, "frontmatter.unclosed");
  assert.equal(r.diagnostics[0]?.pos?.line, 1);
});

test("front matter that is not a mapping is a diagnostic", () => {
  const r = parseFrontMatter("---\n- a\n- b\n---\nbody\n", F);
  assert.deepEqual(r.data, {});
  assert.equal(r.diagnostics[0]?.id, "frontmatter.not-a-mapping");
});
