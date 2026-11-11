import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourcePos } from "../src/contracts/source.ts";
import {
  EXAMPLE_BEST_EFFORT_PROTECTIONS,
  EXAMPLE_FAILED_ID,
  EXAMPLE_SANDBOX_ID,
  exampleFailed,
  exampleSandboxUnavailable,
  firstDifference,
} from "../src/pipeline/examples/diagnostic.ts";

const pos: SourcePos = { file: "guide/install.md", line: 42, column: 1, endLine: 42, endColumn: 3 };

test("example-failed has the id, a warning severity, and the fence's position", () => {
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected: "a", actual: "b" });
  assert.equal(diagnostic.id, "example-failed");
  assert.equal(diagnostic.id, EXAMPLE_FAILED_ID);
  assert.equal(diagnostic.severity, "warning");
  assert.deepEqual(diagnostic.pos, pos);
  assert.equal(
    diagnostic.message,
    `The example on /guide/install/ at guide/install.md:42 failed: expected "a" but got "b".`,
  );
  assert.equal(diagnostic.help, "Update the example's expected output, or fix what it demonstrates.");
});

test("the message names the page, the fence line, and an exit code when the runner knows it", () => {
  const diagnostic = exampleFailed({ pos, page: "/guide/build/", expected: "ok", actual: "bad", exitCode: 2 });
  assert.match(diagnostic.message, /^The example on \/guide\/build\/ at guide\/install\.md:42 failed \(exit code 2\): /);
  assert.equal(diagnostic.message.split("\n").length, 1);
  assert.ok(diagnostic.message.endsWith("."));
});

test("expected output with no actual output shows an empty actual side", () => {
  const expected = "hello\nworld\n";
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected, actual: "" });
  assert.ok(diagnostic.message.includes(String.raw`expected "hello\nworld\n" but got ""`));
});

test("actual output with no expected output shows an empty expected side", () => {
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected: "", actual: "surprise" });
  assert.ok(diagnostic.message.includes(String.raw`expected "" but got "surprise"`));
});

test("a difference in the middle keeps the shared context on both sides", () => {
  const expected = "the quick brown fox jumps over the lazy dog";
  const actual = "the quick brown fox leaps over the lazy dog";
  assert.deepEqual(firstDifference(expected, actual), {
    offset: 20,
    expected: "…quick brown fox jumps over the lazy dog",
    actual: "…quick brown fox leaps over the lazy dog",
  });
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected, actual });
  assert.ok(diagnostic.message.includes(`expected "…quick brown fox jumps over the lazy dog" but got "…quick brown fox leaps over the lazy dog"`));
});

test("very long output is truncated on each side, with an ellipsis marking the cut", () => {
  const expected = `${"a".repeat(500)}X`;
  const actual = `${"a".repeat(500)}Y`;
  const diff = firstDifference(expected, actual);
  assert.equal(diff.offset, 500);
  assert.ok(diff.expected.startsWith("…"));
  assert.ok(diff.expected.endsWith("X"));
  assert.ok(diff.actual.endsWith("Y"));
  assert.ok(diff.expected.length < 100, `expected side is ${diff.expected.length} characters`);
  assert.ok(diff.actual.length < 100, `actual side is ${diff.actual.length} characters`);
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected, actual });
  assert.ok(diagnostic.message.length < 400, `message is ${diagnostic.message.length} characters`);
});

test("multiline and binary-ish output is escaped onto one line without crashing", () => {
  const expected = "line 1\nline 2\t\u0000😀";
  const actual = "line 1\nline 3\t\u0001😀";
  const diff = firstDifference(expected, actual);
  assert.equal(diff.offset, 12);
  assert.equal(diff.expected, String.raw`line 1\nline 2\t\u{0}😀`);
  assert.equal(diff.actual, String.raw`line 1\nline 3\t\u{1}😀`);
  const diagnostic = exampleFailed({ pos, page: "/guide/install/", expected, actual });
  assert.equal(diagnostic.message.includes("\n"), false);
  assert.equal(diagnostic.message.includes("\t"), false);
  assert.equal(diagnostic.message.includes("\u0000"), false);
  assert.ok(diagnostic.message.includes("😀"));
});

test("results depend only on the arguments", () => {
  const options = { pos, page: "/guide/install/", expected: "same prefix A tail", actual: "same prefix B tail" };
  assert.deepEqual(exampleFailed(options), exampleFailed(options));
  assert.deepEqual(firstDifference(options.expected, options.actual), firstDifference(options.expected, options.actual));
});

test("one string being a prefix of the other reports the shorter length", () => {
  assert.deepEqual(firstDifference("abc", "abcd"), { offset: 3, expected: "abc", actual: "abcd" });
  assert.deepEqual(firstDifference("abcd", "abc"), { offset: 3, expected: "abcd", actual: "abc" });
});

test("a host without an OS sandbox gets one explicit trust diagnostic that names the best-effort protections", () => {
  const diagnostic = exampleSandboxUnavailable("linux");
  assert.equal(diagnostic.id, EXAMPLE_SANDBOX_ID);
  assert.equal(diagnostic.id, "example-sandbox");
  assert.equal(diagnostic.severity, "warning");
  assert.match(diagnostic.message, /without an OS sandbox on linux/);
  assert.match(diagnostic.message, /not confined/);
  assert.match(diagnostic.message, /Best-effort only/);
  for (const protection of EXAMPLE_BEST_EFFORT_PROTECTIONS) {
    assert.ok(diagnostic.message.includes(protection), `the message names "${protection}"`);
  }
  assert.equal(diagnostic.pos, undefined, "the finding is about the host, not a source span");
  assert.equal(diagnostic.help?.includes("bwrap"), true);
});

test("the trust diagnostic depends only on the platform", () => {
  assert.deepEqual(exampleSandboxUnavailable("linux"), exampleSandboxUnavailable("linux"));
  assert.notEqual(exampleSandboxUnavailable("linux").message, exampleSandboxUnavailable("win32").message);
});
