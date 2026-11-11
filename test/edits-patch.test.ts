import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyFilePatches,
  applyPatch,
  applyPatches,
  EditFileError,
  formatPatchSpan,
  hashSource,
  PatchError,
  sliceBySpan,
  spanToOffsets,
  writeFilePatches,
  type EditFile,
  type FilePatches,
  type Patch,
  type PatchSpan,
} from "../src/edits/patch.ts";

/** A span on one line; the file stays out unless a test needs it. */
function span(line: number, column: number, endLine: number, endColumn: number, file?: string): PatchSpan {
  return file === undefined ? { line, column, endLine, endColumn } : { file, line, column, endLine, endColumn };
}

function patch(source: string, at: PatchSpan, replacement: string, expected?: string): Patch {
  return expected === undefined ? { span: at, replacement } : { span: at, replacement, expected };
}

/** A patch that carries both preconditions, as a plan does. */
function planned(source: string, at: PatchSpan, replacement: string, expected: string): Patch {
  return { span: at, replacement, expected, beforeHash: hashSource(source) };
}

test("applies a replacement on an ASCII span and keeps the rest byte for byte", () => {
  const source = "one two three\n";
  const result = applyPatch(source, patch(source, span(1, 5, 1, 7), "TWO", "two"));
  assert.equal(result, "one TWO three\n");
  assert.equal(source, "one two three\n", "the source is not mutated");
});

test("an empty replacement deletes exactly the span, including a trailing newline's neighbour", () => {
  const source = "remove me\n";
  assert.equal(applyPatch(source, patch(source, span(1, 1, 1, 6), "", "remove")), " me\n");
});

test("counts Persian columns as Unicode code points and replaces only that word", () => {
  const source = "سلام دنیا، خوش آمدید\n";
  const result = applyPatch(source, patch(source, span(1, 6, 1, 9), "جهان", "دنیا"));
  assert.equal(result, "سلام جهان، خوش آمدید\n");
  assert.equal(sliceBySpan(source, span(1, 6, 1, 9)), "دنیا");
});

test("a ZWNJ is one column, like every other code point", () => {
  const source = "می\u200Cروم\n";
  // م ی ZWNJ ر و م: the third character is the zero-width non-joiner.
  assert.equal(sliceBySpan(source, span(1, 3, 1, 3)), "\u200C");
  assert.equal(applyPatch(source, patch(source, span(1, 3, 1, 3), "-", "\u200C")), "می-روم\n");
});

test("an astral emoji is one column even though it is two UTF-16 code units", () => {
  const source = "Hello 🌍 world\n";
  const emoji = span(1, 7, 1, 7);
  assert.deepEqual(spanToOffsets(source, emoji), { start: 6, end: 8 });
  assert.equal(sliceBySpan(source, emoji), "🌍");
  assert.equal(applyPatch(source, patch(source, emoji, "🌕", "🌍")), "Hello 🌕 world\n");

  // "world" starts after the two-code-unit emoji and the space: column 9, not column 10.
  const world = span(1, 9, 1, 13);
  assert.deepEqual(spanToOffsets(source, world), { start: 9, end: 14 });
  assert.equal(applyPatch(source, patch(source, world, "planet", "world")), "Hello 🌍 planet\n");
});

test("CRLF line endings survive a patch on one line", () => {
  const source = "one\r\ntwo\r\nthree\r\n";
  const result = applyPatch(source, patch(source, span(2, 1, 2, 3), "TWO", "two"));
  assert.equal(result, "one\r\nTWO\r\nthree\r\n");
  assert.equal(result.split("\r\n").length, 4, "every CRLF pair is still a pair");
  assert.equal((result.match(/\r\n/g) ?? []).length, 3, "no line ending changed shape");
});

test("a multi-line span replaces both lines and leaves both CRLF pairs around it", () => {
  const source = "a\r\none\r\ntwo\r\nz\r\n";
  const result = applyPatch(source, patch(source, span(2, 1, 3, 3), "middle", "one\r\ntwo"));
  assert.equal(result, "a\r\nmiddle\r\nz\r\n");
});

test("a span at the start and a span at the end both apply", () => {
  const source = "first\nsecond\n";
  assert.equal(applyPatch(source, patch(source, span(1, 1, 1, 5), "1st", "first")), "1st\nsecond\n");
  assert.equal(applyPatch(source, patch(source, span(2, 1, 2, 6), "2nd", "second")), "first\n2nd\n");
  assert.ok(applyPatch(source, patch(source, span(2, 1, 2, 6), "2nd", "second")).endsWith("\n"));

  // Without a trailing newline there is none to add, and the last character is a normal end.
  const noNewline = "first\nsecond";
  assert.equal(applyPatch(noNewline, patch(noNewline, span(2, 1, 2, 6), "2nd", "second")), "first\n2nd");
});

test("refuses with expected-mismatch when the text at the span changed", () => {
  const source = "hello\n";
  const at = span(1, 1, 1, 5, "guide.md");
  assert.throws(
    () => applyPatch(source, patch(source, at, "x", "world")),
    (error: unknown) => {
      assert.ok(error instanceof PatchError);
      assert.equal(error.name, "PatchError");
      assert.equal(error.code, "expected-mismatch");
      assert.equal(error.span.file, "guide.md");
      assert.equal(error.expected, "world");
      assert.equal(error.actual, "hello");
      assert.match(error.message, /guide\.md:1:1-1:5/);
      assert.match(error.message, /hello/);
      return true;
    },
  );
});

test("refuses a quoted expected text that differs only by line ending", () => {
  const source = "one\r\ntwo\r\n";
  assert.throws(
    () => applyPatch(source, patch(source, span(1, 1, 2, 3), "x", "one\ntwo")),
    (error: unknown) => error instanceof PatchError && error.code === "expected-mismatch",
  );
});

test("refuses out-of-range spans with a typed error for each way of leaving the source", () => {
  const source = "short\nline\n";
  const cases: PatchSpan[] = [
    span(0, 1, 0, 1),
    span(1, 0, 1, 1),
    span(1, 1, 0, 1),
    span(1, 1, 1, 0),
    span(1, 1, 1, 6), // "short" has five columns
    span(1, 2, 1, 1), // end before start
    span(1, 1, 3, 1), // there is no third line
    span(1, 1, 2, 5), // "line" has four columns
    span(1, 1.5, 1, 2),
    span(1, 1, 1.5, 2),
  ];
  for (const at of cases) {
    assert.throws(
      () => applyPatch(source, patch(source, at, "x", "s")),
      (error: unknown) => {
        assert.ok(error instanceof PatchError, `${formatPatchSpan(at)} throws a PatchError`);
        assert.equal(error.code, "out-of-range", `${formatPatchSpan(at)} is out of range`);
        return true;
      },
    );
  }
  // A start just after a line's last character is legal; it names the newline.
  assert.equal(applyPatch(source, patch(source, span(1, 6, 2, 4), "x")), "shortx\n");
});

test("refuses a stale hash before touching the span", () => {
  const source = "hello\n";
  const beforeHash = hashSource("other\n");
  assert.throws(
    () =>
      applyPatch(source, {
        span: span(1, 1, 1, 5),
        expected: "hello",
        replacement: "x",
        beforeHash,
      }),
    (error: unknown) =>
      error instanceof PatchError &&
      error.code === "hash-mismatch" &&
      error.actual === hashSource(source) &&
      error.message.includes(beforeHash),
  );
});

test("accepts a matching hash, in either case", () => {
  const source = "hello\n";
  const beforeHash = hashSource(source);
  assert.equal(applyPatch(source, { span: span(1, 1, 1, 5), replacement: "x", beforeHash }), "x\n");
  assert.equal(
    applyPatch(source, { span: span(1, 1, 1, 5), replacement: "x", beforeHash: beforeHash.toUpperCase() }),
    "x\n",
  );
});

test("a patched file round-trips back to the original by hashing the intermediate", () => {
  const source = "one\r\nدنیا 🌍\r\nthree\r\n";
  const originalHash = hashSource(source);
  // "دنیا 🌍" is 4 + 1 + 1 = 6 columns, before the CR.
  assert.equal(sliceBySpan(source, span(2, 1, 2, 6)), "دنیا 🌍");

  const patched = applyPatch(source, {
    span: span(2, 1, 2, 6),
    expected: "دنیا 🌍",
    replacement: "جهان",
    beforeHash: originalHash,
  });
  assert.equal(patched, "one\r\nجهان\r\nthree\r\n");
  assert.notEqual(hashSource(patched), originalHash);

  const backwards = applyPatch(patched, {
    span: span(2, 1, 2, 4),
    expected: "جهان",
    replacement: "دنیا 🌍",
    beforeHash: hashSource(patched),
  });
  assert.equal(backwards, source);
  assert.equal(hashSource(backwards), originalHash);
});

test("hashSource is SHA-256 of the UTF-8 bytes, stable across calls", () => {
  assert.equal(hashSource(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hashSource("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hashSource("🌍"), hashSource("🌍"));
  assert.notEqual(hashSource("a\r\nb"), hashSource("a\nb"));
});

test("applyPatch is pure and deterministic", () => {
  const source = "alpha beta\n";
  const at = patch(source, span(1, 7, 1, 10), "BETA", "beta");
  const first = applyPatch(source, at);
  const second = applyPatch(source, at);
  assert.equal(first, second);
  assert.equal(source, "alpha beta\n");
});

test("applies a set of non-overlapping patches in one pass, whatever order they come in", () => {
  const source = "one two three\n";
  const result = applyPatches(source, [
    patch(source, span(1, 9, 1, 13), "THREE", "three"),
    patch(source, span(1, 5, 1, 7), "TWO", "two"),
  ]);

  assert.equal(result.text, "one TWO THREE\n");
  assert.equal(source, "one two three\n", "the source is not mutated");
  assert.deepEqual(result.spans, [span(1, 5, 1, 7), span(1, 9, 1, 13)]);
});

test("adjacent spans are not an overlap, and a deletion leaves no resulting span", () => {
  assert.equal(
    applyPatches("ab\n", [patch("ab\n", span(1, 1, 1, 1), "x", "a"), patch("ab\n", span(1, 2, 1, 2), "y", "b")]).text,
    "xy\n",
  );

  const deleted = applyPatches("abc\n", [{ span: span(1, 2, 1, 2), replacement: "" }]);
  assert.equal(deleted.text, "ac\n");
  assert.deepEqual(deleted.spans, []);
});

test("records where a multi-line replacement lands in the result", () => {
  const result = applyPatches("a\nb\n", [{ span: span(1, 1, 1, 1), replacement: "x\ny" }]);
  assert.equal(result.text, "x\ny\nb\n");
  assert.deepEqual(result.spans, [span(1, 1, 2, 1)]);
});

test("refuses overlapping spans and the same span twice, naming both spans", () => {
  const source = "abcdef\n";
  assert.throws(
    () =>
      applyPatches(source, [
        patch(source, span(1, 1, 1, 3), "x"),
        patch(source, span(1, 3, 1, 5), "y"),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof PatchError);
      assert.equal(error.code, "overlapping-spans");
      assert.match(error.message, /1:1-1:3/);
      assert.match(error.message, /1:3-1:5/);
      assert.equal(error.span.line, 1);
      return true;
    },
  );

  assert.throws(
    () =>
      applyPatches(source, [
        patch(source, span(1, 1, 1, 3), "x"),
        patch(source, span(1, 1, 1, 3), "y"),
      ]),
    (error: unknown) => error instanceof PatchError && error.code === "ambiguous-span",
  );
});

test("a stale hash on any patch refuses the whole set before it produces text", () => {
  const source = "one two\n";
  assert.throws(
    () =>
      applyPatches(source, [
        patch(source, span(1, 1, 1, 3), "ONE", "one"),
        { span: span(1, 5, 1, 7), expected: "two", replacement: "TWO", beforeHash: hashSource("other\n") },
      ]),
    (error: unknown) => error instanceof PatchError && error.code === "hash-mismatch",
  );
});

test("applies a whole edit set across files, with hashes and resulting spans per file", () => {
  const files: FilePatches[] = [
    { file: "docs/a.md", source: "# Old\n", patches: [patch("# Old\n", span(1, 3, 1, 5, "docs/a.md"), "New", "Old")] },
    { file: "docs/b.md", source: "body\n", patches: [patch("body\n", span(1, 1, 1, 4, "docs/b.md"), "text", "body")] },
  ];
  const results = applyFilePatches(files);

  assert.deepEqual(
    results.map((result) => result.after),
    ["# New\n", "text\n"],
  );
  assert.equal(results[0]?.beforeHash, hashSource("# Old\n"));
  assert.equal(results[0]?.afterHash, hashSource("# New\n"));
  assert.deepEqual(results[0]?.spans, [span(1, 3, 1, 5)]);
  assert.deepEqual(results[1]?.spans, [span(1, 1, 1, 4)]);
});

test("one refused file refuses the whole set and names the file", () => {
  const files: FilePatches[] = [
    { file: "docs/a.md", source: "# Old\n", patches: [patch("# Old\n", span(1, 3, 1, 5), "New", "Old")] },
    {
      file: "docs/b.md",
      source: "body\n",
      patches: [
        { span: span(1, 1, 1, 4, "docs/b.md"), expected: "body", replacement: "text", beforeHash: "0".repeat(64) },
      ],
    },
  ];

  assert.throws(
    () => applyFilePatches(files),
    (error: unknown) => error instanceof PatchError && error.code === "hash-mismatch" && error.span.file === "docs/b.md",
  );
});

test("refuses a duplicate file and a patch that names another file", () => {
  const files: FilePatches[] = [
    { file: "docs/a.md", source: "# Old\n", patches: [] },
    { file: "docs/a.md", source: "# Old\n", patches: [] },
  ];
  assert.throws(
    () => applyFilePatches(files),
    (error: unknown) =>
      error instanceof EditFileError && error.code === "duplicate-file" && error.file === "docs/a.md",
  );

  assert.throws(
    () =>
      applyFilePatches([
        {
          file: "docs/a.md",
          source: "# Old\n",
          patches: [patch("# Old\n", span(1, 3, 1, 5, "docs/b.md"), "New", "Old")],
        },
      ]),
    (error: unknown) =>
      error instanceof EditFileError && error.code === "file-mismatch" && error.file === "docs/a.md",
  );
});

/** A temporary tree holding `files`, removed by the caller. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "edits-patch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The bytes of a tree, keyed by relative path, for a byte-for-byte comparison. */
function snapshot(root: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

test("writes a whole edit set, and a stale hash in one file leaves every file byte-identical", async () => {
  const root = tree({ "docs/a.md": "# Old\n", "docs/b.md": "body\n" });
  const before = snapshot(root, ["docs/a.md", "docs/b.md"]);
  try {
    const edit: EditFile[] = [
      { file: "docs/a.md", patches: [planned(before["docs/a.md"]!, span(1, 3, 1, 5, "docs/a.md"), "New", "Old")] },
      { file: "docs/b.md", patches: [planned(before["docs/b.md"]!, span(1, 1, 1, 4, "docs/b.md"), "text", "body")] },
    ];
    const results = await writeFilePatches(root, edit);
    assert.deepEqual(
      results.map((result) => result.after),
      ["# New\n", "text\n"],
    );
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# New\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "text\n");
    assert.deepEqual(readdirSync(join(root, "docs")), ["a.md", "b.md"], "no staging folder is left");

    const stale: EditFile[] = [
      { file: "docs/a.md", patches: [planned("# New\n", span(1, 3, 1, 5, "docs/a.md"), "Newer", "New")] },
      { file: "docs/b.md", patches: [{ ...edit[1]!.patches[0]!, beforeHash: "0".repeat(64) }] },
    ];
    await assert.rejects(
      writeFilePatches(root, stale),
      (error: unknown) => error instanceof PatchError && error.code === "hash-mismatch",
    );
    assert.deepEqual(
      snapshot(root, ["docs/a.md", "docs/b.md"]),
      { "docs/a.md": "# New\n", "docs/b.md": "text\n" },
      "the second refusal changed nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused multi-file edit leaves the original tree byte-for-byte intact", async () => {
  const root = tree({ "docs/a.md": "# Old\n", "docs/b.md": "body\n" });
  const before = snapshot(root, ["docs/a.md", "docs/b.md"]);
  try {
    await assert.rejects(
      writeFilePatches(root, [
        { file: "docs/a.md", patches: [planned(before["docs/a.md"]!, span(1, 3, 1, 5, "docs/a.md"), "New", "Old")] },
        {
          file: "docs/b.md",
          patches: [
            { span: span(1, 1, 1, 4, "docs/b.md"), expected: "other", replacement: "text", beforeHash: hashSource(before["docs/b.md"]!) },
          ],
        },
      ]),
      (error: unknown) => error instanceof PatchError && error.code === "expected-mismatch",
    );
    assert.deepEqual(snapshot(root, ["docs/a.md", "docs/b.md"]), before);
    assert.deepEqual(readdirSync(join(root, "docs")), ["a.md", "b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writing requires the source hash and the exact expected text by default", async () => {
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    await assert.rejects(
      writeFilePatches(root, [
        { file: "docs/a.md", patches: [{ span: span(1, 1, 1, 5, "docs/a.md"), replacement: "# New" }] },
      ]),
      (error: unknown) => error instanceof PatchError && error.code === "missing-hash",
    );
    await assert.rejects(
      writeFilePatches(
        root,
        [
          {
            file: "docs/a.md",
            patches: [{ span: span(1, 1, 1, 5, "docs/a.md"), replacement: "# New", beforeHash: hashSource("# Old\n") }],
          },
        ],
        { requireHash: true, requireExpected: true },
      ),
      (error: unknown) => error instanceof PatchError && error.code === "missing-expected",
    );
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# Old\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireExpected: false still requires the source hash", async () => {
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    await assert.rejects(
      writeFilePatches(
        root,
        [
          {
            file: "docs/a.md",
            patches: [{ span: span(1, 1, 1, 5, "docs/a.md"), expected: "# Old", replacement: "# New" }],
          },
        ],
        { requireExpected: false },
      ),
      (error: unknown) => error instanceof PatchError && error.code === "missing-hash",
    );
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# Old\n");

    const results = await writeFilePatches(
      root,
      [
        {
          file: "docs/a.md",
          patches: [
            {
              span: span(1, 1, 1, 5, "docs/a.md"),
              replacement: "# New",
              beforeHash: hashSource("# Old\n"),
            },
          ],
        },
      ],
      { requireExpected: false },
    );
    assert.equal(results[0]?.after, "# New\n");
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# New\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireHash: false still requires the expected text", async () => {
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    await assert.rejects(
      writeFilePatches(
        root,
        [
          {
            file: "docs/a.md",
            patches: [
              {
                span: span(1, 1, 1, 5, "docs/a.md"),
                replacement: "# New",
                beforeHash: hashSource("# Old\n"),
              },
            ],
          },
        ],
        { requireHash: false },
      ),
      (error: unknown) => error instanceof PatchError && error.code === "missing-expected",
    );
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# Old\n");

    const results = await writeFilePatches(
      root,
      [
        {
          file: "docs/a.md",
          patches: [{ span: span(1, 1, 1, 5, "docs/a.md"), expected: "# Old", replacement: "# New" }],
        },
      ],
      { requireHash: false },
    );
    assert.equal(results[0]?.after, "# New\n");
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# New\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a file outside the site root, a missing file, and the same file spelled twice", async () => {
  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n" });
  const site = join(parent, "site");
  const edits = (file: string): EditFile[] => [
    { file, patches: [planned("# Old\n", span(1, 3, 1, 5), "New", "Old")] },
  ];
  try {
    await assert.rejects(
      writeFilePatches(site, edits("../outside.md")),
      (error: unknown) =>
        error instanceof EditFileError && error.code === "path-escape" && error.file === "../outside.md",
    );
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");

    await assert.rejects(
      writeFilePatches(site, edits("docs/missing.md")),
      (error: unknown) =>
        error instanceof EditFileError && error.code === "source-missing" && error.file === "docs/missing.md",
    );

    await assert.rejects(
      writeFilePatches(site, [...edits("docs/a.md"), ...edits("./docs/a.md")]),
      (error: unknown) =>
        error instanceof EditFileError && error.code === "duplicate-file" && error.file === "docs/a.md",
    );
    assert.equal(readFileSync(join(site, "docs/a.md"), "utf8"), "# Old\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("requireExpected and requireHash refuse a patch that carries neither", () => {
  const source = "hello\n";
  assert.throws(
    () => applyPatch(source, { span: span(1, 1, 1, 5), replacement: "x" }, { requireExpected: true }),
    (error: unknown) => error instanceof PatchError && error.code === "missing-expected",
  );
  assert.throws(
    () => applyPatch(source, { span: span(1, 1, 1, 5), replacement: "x" }, { requireHash: true }),
    (error: unknown) => error instanceof PatchError && error.code === "missing-hash",
  );
  assert.equal(applyPatch(source, { span: span(1, 1, 1, 5), replacement: "x" }), "x\n");
});
