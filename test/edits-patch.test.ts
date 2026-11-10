import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPatch,
  formatPatchSpan,
  hashSource,
  PatchError,
  sliceBySpan,
  spanToOffsets,
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
