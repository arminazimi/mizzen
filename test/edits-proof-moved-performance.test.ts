/**
 * Bounds the work a moved-span search does (#101).
 *
 * The verifier used to hash the whole substring at every code-point offset of a changed file, so a
 * long span in a large file cost quadratic hashing and repeated prefix rescans. These tests hold the
 * rewrite to two things: the search must stay linear plus a bounded number of confirmations, and it
 * must report exactly what the old per-offset search reported. The old algorithm is reproduced here,
 * verbatim, as the oracle the new one is compared against, and the work is measured by counters the
 * search reports through its own seams (`MovedTextIndex` results, and the `onSearch` observation of
 * `verifyProofFiles`) rather than by the wall clock, so nothing here depends on how loaded the machine
 * is. The per-test timeout is only a hang guard; no assertion reads a duration.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sliceBySpan } from "../src/edits/patch.ts";
import {
  MOVED_CANDIDATE_CODE_POINTS,
  MOVED_CANDIDATE_CONFIRMATIONS,
  MOVED_SCAN_CODE_POINTS,
  MOVED_SPAN_CODE_POINTS,
  MovedTextIndex,
  verifyProofFiles,
  type MovedPosition,
  type MovedSearchObservation,
  type MovedSearchResult,
  type ProofFileEvidence,
  type ProofFileVerification,
  type ProofVerifyIssue,
} from "../src/edits/proof-verifier.ts";
import type { ProofSpan } from "../src/edits/proof.ts";

/** A hang guard only. */
const HANG_TIMEOUT_MS = 180_000;

/** SHA-256 of a text as UTF-8, the way a proof hashes a span. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The caps the old search was written under, repeated here so the oracle cannot drift with the module. */
const REFERENCE_SCAN_CODE_POINTS = 2_000_000;
const REFERENCE_SPAN_CODE_POINTS = 100_000;

/** The line and column of a code-point index, as the old search computed it. */
function positionAt(points: readonly string[], index: number): { readonly line: number; readonly column: number } {
  let line = 1;
  let column = 1;
  for (let at = 0; at < index; at += 1) {
    if (points[at] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** The old search: a whole-substring SHA-256 at every offset, and a prefix rescan for the match. */
function referenceMoved(text: string, length: number, hash: string): MovedPosition | undefined {
  if (length < 1 || length > REFERENCE_SPAN_CODE_POINTS) return undefined;
  const points = Array.from(text);
  if (points.length > REFERENCE_SCAN_CODE_POINTS || length > points.length) return undefined;
  for (let start = 0; start + length <= points.length; start += 1) {
    if (sha256(points.slice(start, start + length).join("")) !== hash) continue;
    const first = positionAt(points, start);
    const last = positionAt(points, start + length - 1);
    return { line: first.line, column: first.column, endLine: last.line, endColumn: last.column };
  }
  return undefined;
}

/** The old span check, issue for issue, so the new one can be held to the same contract. */
function referenceIssues(path: string, text: string, spans: readonly ProofSpan[]): ProofVerifyIssue[] {
  const issues: ProofVerifyIssue[] = [];
  const bySpan = (a: ProofSpan, b: ProofSpan): number =>
    a.line - b.line || a.column - b.column || a.endLine - b.endLine || a.endColumn - b.endColumn;
  for (const span of [...spans].sort(bySpan)) {
    const rangeIssue: ProofVerifyIssue = {
      code: "verify.span.range",
      path,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
      hash: span.hash,
    };
    let slice: string;
    try {
      slice = sliceBySpan(text, span);
    } catch {
      issues.push(rangeIssue);
      continue;
    }
    if (slice === "") {
      issues.push(rangeIssue);
      continue;
    }
    if (sha256(slice) === span.hash) continue;
    const moved = referenceMoved(text, Array.from(slice).length, span.hash);
    if (moved !== undefined) {
      issues.push({
        code: "verify.span.moved",
        path,
        line: span.line,
        column: span.column,
        endLine: span.endLine,
        endColumn: span.endColumn,
        hash: span.hash,
        foundLine: moved.line,
        foundColumn: moved.column,
        foundEndLine: moved.endLine,
        foundEndColumn: moved.endColumn,
      });
      continue;
    }
    issues.push({
      code: "verify.span.hash",
      path,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
      hash: span.hash,
    });
  }
  return issues;
}

/**
 * The text a reported position names, computed independently of the search.
 *
 * The line table here is rebuilt straight from `Array.from`, so a position the search read off its own
 * precomputed table agrees only when both really mean the same line and column.
 */
function textAt(points: readonly string[], position: MovedPosition): string {
  const starts: number[] = [0];
  for (let at = 0; at < points.length; at += 1) {
    if (points[at] === "\n") starts.push(at + 1);
  }
  const first = starts[position.line - 1];
  const last = starts[position.endLine - 1];
  if (first === undefined || last === undefined) return "";
  const from = first + position.column - 1;
  const to = last + position.endColumn - 1;
  if (from < 0 || to < from || to >= points.length) return "";
  return points.slice(from, to + 1).join("");
}

/** A small deterministic pseudo-random generator, so every fuzz case is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * One of the alphabets a fuzz case builds its text from. The last three are the sharp edges: a lone
 * surrogate counts as one code point, a single repeated character puts every window on one
 * fingerprint, and CRLF mixed with flag pairs keeps a CR inside the column count.
 */
const ALPHABETS: readonly (readonly string[])[] = [
  ["a", "b", "c", "d", "e", " ", "\n"],
  ["k", "e", "e", "p", "\r", "\n", "m", "o", "v", "d", " ", "b", "l", "c"],
  ["a", "\u{1f600}", "b", "\u{1f600}", "c", " ", "\n", "\u0301"],
  ["é", "è", "ê", "ě", "ß", " ", "\n", "\r"],
  Array.from("the quick brown fox jumps over a lazy dog. THE0123456789\n"),
  ["\ud800", "\udbff", "\udc00", "\udfff", "x", "\n", "\r"],
  ["a"],
  ["\ud800", "z", "\n"],
  Array.from("ab\r\n🇦🇧 \n"),
];

/** A text of about `size` code points from `alphabet`, drawing its pieces from `next`. */
function textOf(alphabet: readonly string[], size: number, next: () => number): string {
  let text = "";
  let count = 0;
  while (count < size) {
    const piece = alphabet[Math.floor(next() * alphabet.length)]!;
    text += piece;
    count += Array.from(piece).length;
  }
  return text;
}

/** A span over `column..endColumn` of one line, recording the given hash. */
function span(line: number, endColumn: number, hash: string, column = 1, endLine = line): ProofSpan {
  return { line, column, endLine, endColumn, hash };
}

/**
 * A corpus of the cases the contract names: a plain move, a duplicated needle, text that is missing,
 * astral characters, CRLF line endings, multi-line moves, edge offsets, and range failures.
 *
 * A search measures the slice the recorded span covers, so every case that must report a move records
 * a span whose slice holds exactly as many code points as the text it points at.
 */
interface CorpusCase {
  readonly path: string;
  readonly content: string;
  readonly spans: readonly ProofSpan[];
}

function corpus(): CorpusCase[] {
  return [
    {
      // A move to the next line, a needle that is simply absent, and a span outside the file.
      path: "docs/moved.md",
      content: "alpha\nworld\n",
      spans: [span(1, 5, sha256("world")), span(1, 5, sha256("xxxxx")), span(9, 5, sha256("world"))],
    },
    {
      // "abc" sits three times: the first occurrence wins, not the one nearest the recorded span.
      path: "docs/three.md",
      content: "abc abc abc def\n",
      spans: [span(1, 13, sha256("abc"), 11), span(1, 13, sha256("c def ghi jkl"))],
    },
    {
      // The same text on three lines: the earliest line wins.
      path: "docs/dup2.md",
      content: "abc abc abc\nabc abc abc\nxyz abc abc\n",
      spans: [span(3, 11, sha256("abc abc abc"))],
    },
    {
      // One code point per emoji: a column of 5 is the fifth code point, not the ninth UTF-16 unit.
      path: "docs/astral.md",
      content: "a😀b c😀d\n😀😀😀 tail\n",
      spans: [
        span(1, 3, sha256("c😀d")),
        span(1, 5, sha256("😀x😀😀😀")),
        span(2, 3, sha256("a😀b")),
      ],
    },
    {
      path: "docs/pairs.md",
      content: `${"😀".repeat(30)}x${"😀".repeat(3)}y`,
      spans: [span(1, 5, sha256("😀x😀😀😀"))],
    },
    {
      // A CR counts as a column, a needle of another length is never a move, and an intact multi-line
      // span reports nothing at all.
      path: "docs/crlf.md",
      content: "alpha\r\nworld\r\ncafe\r\n",
      spans: [span(1, 5, sha256("world")), span(1, 5, sha256("cafe")), span(1, 5, sha256("alpha\r\n"), 1, 2)],
    },
    {
      // A moved block that ends on its line feed, and one that carries the CRLF inside it.
      path: "docs/crlf2.md",
      content: "keep\r\nmoved block\r\ntail\r\n",
      spans: [span(1, 1, sha256("moved b"), 1, 2), span(1, 7, sha256("moved block\r\n"), 1, 2)],
    },
    {
      path: "docs/multiline.md",
      content: "first\nsecond\nthird\n",
      spans: [span(1, 4, sha256("cond")), span(1, 5, sha256("econd")), span(3, 5, sha256("first\n"))],
    },
    {
      // A move whose own span runs across a line break.
      path: "docs/multiline2.md",
      content: "first\nsecond\nthird\n",
      spans: [span(3, 5, sha256("nd\nth"))],
    },
    {
      // A one-code-point move, landing on the very first window, and a move one column along.
      path: "docs/edges.md",
      content: "zabcz",
      spans: [span(1, 2, sha256("z"), 2)],
    },
    { path: "docs/edge2.md", content: "abcz", spans: [span(1, 3, sha256("bcz"))] },
    {
      // A file whose slices carry their line feeds: an intact span, a move across an empty line, and a
      // span on a line that holds no columns at all.
      path: "docs/linebreaks.md",
      content: "ab\n\ncd\n",
      spans: [span(1, 2, sha256("cd")), span(1, 1, sha256("b\n\ncd"), 1, 3), span(2, 1, sha256("ab"))],
    },
    {
      // Twenty identical filler lines, with the needle only at the very end: the case the per-offset
      // search hashed once per offset.
      path: "docs/repeated.md",
      content: `${"filler line of text\n".repeat(20)}needle text here\n`,
      spans: [span(1, 11, sha256("needle text")), span(1, 17, sha256("needle text here\n"))],
    },
    {
      // Every window of the file shares one fingerprint, and none of them is the recorded hash.
      path: "docs/uniform.md",
      content: "y".repeat(500),
      spans: [span(1, 40, sha256("!".repeat(40))), span(1, 40, sha256(`${"y".repeat(39)}!`))],
    },
  ];
}

/** Writes the corpus to a temporary site and returns its root. */
function siteOf(cases: readonly CorpusCase[]): string {
  const root = mkdtempSync(join(tmpdir(), "moved-perf-"));
  for (const entry of cases) {
    mkdirSync(dirname(join(root, entry.path)), { recursive: true });
    writeFileSync(join(root, entry.path), entry.content);
  }
  return root;
}

/** The evidence a corpus case records: its real after hash and its spans. */
function evidenceOf(cases: readonly CorpusCase[]): ProofFileEvidence[] {
  return cases.map((entry) => ({ path: entry.path, after: sha256(entry.content), spans: entry.spans }));
}

/** The [foundLine, foundColumn, foundEndLine, foundEndColumn] of every move one file reports. */
function moves(report: readonly ProofFileVerification[], path: string): number[][] {
  const file = report.find((entry) => entry.path === path);
  return (file?.issues ?? [])
    .filter((issue) => issue.code === "verify.span.moved")
    .map((issue) => [
      issue.foundLine ?? -1,
      issue.foundColumn ?? -1,
      issue.foundEndLine ?? -1,
      issue.foundEndColumn ?? -1,
    ]);
}

test(
  "the documented caps are the ones the contract names",
  { timeout: HANG_TIMEOUT_MS },
  () => {
    assert.equal(MOVED_SCAN_CODE_POINTS, REFERENCE_SCAN_CODE_POINTS);
    assert.equal(MOVED_SPAN_CODE_POINTS, REFERENCE_SPAN_CODE_POINTS);
    assert.ok(Number.isInteger(MOVED_CANDIDATE_CONFIRMATIONS) && MOVED_CANDIDATE_CONFIRMATIONS > 0);
    assert.ok(Number.isInteger(MOVED_CANDIDATE_CODE_POINTS) && MOVED_CANDIDATE_CODE_POINTS > 0);
    // What makes the hashing bounded: the old worst case hashed every window of the largest allowed
    // file at the longest allowed length. The new one hands SHA-256 a thousand times less text.
    assert.ok(
      MOVED_CANDIDATE_CODE_POINTS * 1000 < MOVED_SCAN_CODE_POINTS * MOVED_SPAN_CODE_POINTS,
      "the hashed work must stay far below the per-offset worst case",
    );
  },
);

test(
  "the rewritten search reports the coordinates and codes the per-offset search reported",
  { timeout: HANG_TIMEOUT_MS },
  async () => {
    const cases = corpus();
    const root = siteOf(cases);
    try {
      const actual = await verifyProofFiles(root, evidenceOf(cases));

      const expected: ProofFileVerification[] = [...cases]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => ({
          path: entry.path,
          outcome: "ok",
          spans: entry.spans.length,
          issues: referenceIssues(entry.path, entry.content, entry.spans),
        }));

      assert.deepEqual(actual, expected, "every case must agree with the old search, field for field");

      // The corpus is not vacuous: a move, a miss, and a range failure all appear.
      const codes = actual.flatMap((file) => file.issues.map((issue) => issue.code));
      for (const code of ["verify.span.moved", "verify.span.hash", "verify.span.range"] as const) {
        assert.ok(codes.includes(code), `the corpus never produces ${code}`);
      }

      // And the contract's own coordinates are named, not merely agreed with by two implementations.
      assert.deepEqual(moves(actual, "docs/moved.md"), [[2, 1, 2, 5]]);
      assert.deepEqual(moves(actual, "docs/three.md"), [[1, 1, 1, 3]]);
      assert.deepEqual(moves(actual, "docs/dup2.md"), [[1, 1, 1, 11]]);
      assert.deepEqual(moves(actual, "docs/astral.md"), [
        [1, 5, 1, 7],
        [1, 1, 1, 3],
      ]);
      assert.deepEqual(moves(actual, "docs/pairs.md"), [[1, 30, 1, 34]]);
      assert.deepEqual(moves(actual, "docs/crlf.md"), [[2, 1, 2, 5]]);
      assert.deepEqual(moves(actual, "docs/crlf2.md"), [
        [2, 1, 2, 7],
        [2, 1, 2, 13],
      ]);
      assert.deepEqual(moves(actual, "docs/multiline.md"), [
        [2, 3, 2, 6],
        [2, 2, 2, 6],
      ]);
      // A move across a line break keeps its own end line and column.
      assert.deepEqual(moves(actual, "docs/multiline2.md"), [[2, 5, 3, 2]]);
      assert.deepEqual(moves(actual, "docs/edges.md"), [[1, 1, 1, 1]]);
      assert.deepEqual(moves(actual, "docs/edge2.md"), [[1, 2, 1, 4]]);
      assert.deepEqual(moves(actual, "docs/repeated.md"), [
        [21, 1, 21, 11],
        [21, 1, 21, 17],
      ]);
      assert.deepEqual(moves(actual, "docs/linebreaks.md"), [
        [3, 1, 3, 2],
        [1, 2, 3, 2],
      ]);
      assert.deepEqual(
        actual.find((file) => file.path === "docs/linebreaks.md")!.issues.map((issue) => issue.code),
        ["verify.span.moved", "verify.span.moved", "verify.span.range"],
        "a span on a column-less line is a range failure",
      );
      assert.deepEqual(
        actual.find((file) => file.path === "docs/uniform.md")!.issues.map((issue) => issue.code),
        ["verify.span.hash", "verify.span.hash"],
        "a file of one repeated character names no move",
      );

      // Every reported move really points at the text the proof recorded.
      const byPath = new Map(cases.map((entry) => [entry.path, entry.content]));
      for (const file of actual) {
        const points = Array.from(byPath.get(file.path)!);
        for (const issue of file.issues) {
          if (issue.code !== "verify.span.moved" || issue.hash === undefined) continue;
          assert.equal(
            sha256(
              textAt(points, {
                line: issue.foundLine!,
                column: issue.foundColumn!,
                endLine: issue.foundEndLine!,
                endColumn: issue.foundEndColumn!,
              }),
            ),
            issue.hash,
            `${file.path}: the found span does not hold the recorded text`,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a lone surrogate and an astral pair are one code point and one column each",
  { timeout: HANG_TIMEOUT_MS },
  () => {
    // A lone surrogate survives in memory, which is where a proof measures a span.
    const text = "a\ud800b c\ud800d\n😀\ud800 tail\n";
    const points = Array.from(text);
    assert.equal(new MovedTextIndex(text).codePoints, points.length);
    assert.equal(points.length, 16);

    const lone = new MovedTextIndex(text).search(3, sha256("c\ud800d"));
    assert.deepEqual(lone.position, referenceMoved(text, 3, sha256("c\ud800d")));
    assert.deepEqual(lone.position, { line: 1, column: 5, endLine: 1, endColumn: 7 });
    assert.equal(textAt(points, lone.position!), "c\ud800d");

    const pair = new MovedTextIndex(text).search(2, sha256("😀\ud800"));
    assert.deepEqual(pair.position, { line: 2, column: 1, endLine: 2, endColumn: 2 });
    assert.equal(textAt(points, pair.position!), "😀\ud800");

    // A needle the file does not hold of that length is no move at all.
    const absent = new MovedTextIndex(text).search(4, sha256("d\n😀"));
    assert.deepEqual(absent.position, undefined);
    assert.equal(absent.outcome, "absent");
  },
);

test(
  "fuzzed texts report the same move the whole-substring search found, or the same absence",
  { timeout: HANG_TIMEOUT_MS },
  () => {
    let found = 0;
    let absent = 0;
    for (let seed = 1; seed <= 220; seed += 1) {
      const next = random(seed * 7919 + 13);
      const alphabet = ALPHABETS[Math.floor(next() * ALPHABETS.length)]!;
      const size = 8 + Math.floor(next() * 900);
      const text = textOf(alphabet, size, next);
      const points = Array.from(text);
      const length = 1 + Math.floor(next() * Math.min(60, points.length));
      if (length > points.length) continue;
      const at = Math.floor(next() * (points.length - length + 1));
      const needle = points.slice(at, at + length).join("");
      // Half the cases hash text that is in the file, the other half hash text that is not.
      const variant = next();
      const target = variant < 0.5 ? needle : variant < 0.8 ? `${needle}!` : `!${needle}`;
      const hash = sha256(target);

      const result = new MovedTextIndex(text).search(length, hash);
      assert.deepEqual(
        result.position,
        referenceMoved(text, length, hash),
        `seed ${seed}: the bounded search must name the offset the per-offset search names`,
      );
      if (result.position === undefined) {
        absent += 1;
        assert.equal(result.outcome, "absent", `seed ${seed}: a small text never reaches a cap`);
      } else {
        found += 1;
        assert.equal(result.outcome, "found");
        // The coordinates are the needle's own, read back through an independently built line table.
        assert.equal(
          textAt(points, result.position),
          target,
          `seed ${seed}: the reported span does not hold the searched text`,
        );
      }
      const windows = points.length - length + 1;
      assert.ok(result.scannedOffsets <= windows, `seed ${seed}: more offsets than the text holds`);
      assert.ok(result.confirmations <= windows, `seed ${seed}: more confirmations than windows`);
      assert.equal(result.candidateCodePoints, result.confirmations * length, `seed ${seed}: unbounded hashing`);
      assert.equal(new MovedTextIndex(text).codePoints, points.length, `seed ${seed}: a wrong code-point count`);
    }
    assert.ok(found > 40 && absent > 40, `the fuzz must cover both branches (found ${found}, absent ${absent})`);
  },
);

test(
  "a large file of repeated text is searched in one linear pass with a fixed handful of confirmations",
  { timeout: HANG_TIMEOUT_MS },
  () => {
    const needle = "the moved block, late in a large file\n";
    const needlePoints = Array.from(needle).length;
    const build = (filler: number): string => `${"y".repeat(filler)}${needle}`;
    const search = (filler: number): MovedSearchResult =>
      new MovedTextIndex(build(filler)).search(needlePoints, sha256(needle));

    const small = search(250_000);
    assert.equal(small.outcome, "found");
    assert.deepEqual(small.position, referenceMoved(build(250_000), needlePoints, sha256(needle)));

    const large = search(1_000_000);
    assert.equal(large.outcome, "found");
    // The needle starts at code point 1_000_001, and its last code point is the file's last column.
    assert.deepEqual(large.position, {
      line: 1,
      column: 1_000_001,
      endLine: 1,
      endColumn: 1_000_000 + needlePoints,
    });
    assert.equal(textAt(Array.from(build(1_000_000)), large.position!), needle);

    // Scanning is linear: four times the text costs four times the offsets, one per window at most.
    assert.equal(large.scannedOffsets, 1_000_001);
    assert.ok(
      Math.abs(large.scannedOffsets / small.scannedOffsets - 4) < 0.02,
      `${small.scannedOffsets} vs ${large.scannedOffsets}`,
    );

    // Confirmation is constant: it counts distinct candidates, not offsets. The per-offset search
    // hashed every one of these offsets, so a regression shows up here whatever the machine is doing.
    assert.equal(large.confirmations, small.confirmations, "repeated text costs the same confirmations at any size");
    assert.ok(large.confirmations <= needlePoints + 2, `${large.confirmations} confirmations for one needle`);
    assert.ok(large.confirmations * 1000 < large.scannedOffsets, "confirmations must stay a fraction of offsets");
    assert.equal(large.candidateCodePoints, large.confirmations * needlePoints);
    assert.ok(large.candidateCodePoints < MOVED_CANDIDATE_CODE_POINTS / 100);

    // A file of one repeated character confirms a single candidate however long it is, and finds nothing.
    const uniform = new MovedTextIndex("q".repeat(1_000_000)).search(64, sha256(`${"q".repeat(63)}!`));
    assert.equal(uniform.outcome, "absent");
    assert.equal(uniform.confirmations, 1, "repeated text costs one confirmation, not one per offset");
    assert.equal(uniform.scannedOffsets, 1_000_000 - 64 + 1);
    assert.equal(uniform.candidateCodePoints, 64);
  },
);

test(
  "many spans in one file share one index and one precomputed position table",
  { timeout: HANG_TIMEOUT_MS },
  async () => {
    const unit = "a line that repeats over and over\n";
    const tail = "a tail that is searched for\n";
    const text = unit.repeat(40) + tail;
    const points = Array.from(text);
    const index = new MovedTextIndex(text);
    assert.equal(index.codePoints, points.length);
    assert.equal(index.lineIndexBuilds, 0, "counting code points builds no position table");

    // The unit is the text at offset 0, so its own hash is a move to line 1; the line feed it ends with
    // is a column of the line it closes, exactly as a recorded span measures it.
    const first = index.search(Array.from(unit).length, sha256(unit));
    assert.deepEqual(first.position, { line: 1, column: 1, endLine: 1, endColumn: 34 });
    assert.equal(index.lineIndexBuilds, 1, "the first match builds the table once");

    const last = index.search(Array.from(tail).length, sha256(tail));
    assert.deepEqual(last.position, { line: 41, column: 1, endLine: 41, endColumn: 28 });
    assert.equal(textAt(points, last.position!), tail);
    // One table answers a match 1,360 code points in; the old search rescanned the prefix for each one.
    assert.equal(index.lineIndexBuilds, 1, "a second match reuses the table");
    assert.equal(index.positionsResolved, 2);
    assert.equal(last.scannedOffsets, points.length - Array.from(tail).length + 1);
    assert.ok(
      last.confirmations * 8 < last.scannedOffsets,
      `${last.confirmations} confirmations for ${last.scannedOffsets} windows of one repeated unit`,
    );

    // Fifty more searches, matching or not, never build the table again.
    for (let round = 0; round < 25; round += 1) {
      assert.equal(index.search(Array.from(tail).length, sha256(tail)).outcome, "found");
      assert.equal(index.search(5, sha256("zzzzz")).outcome, "absent");
    }
    assert.equal(index.lineIndexBuilds, 1, "the table is built once per file, not once per span");
    assert.equal(index.positionsResolved, 2 + 25);

    // Through the file check: every moved span of one file is searched, and one table serves them all.
    const root = mkdtempSync(join(tmpdir(), "moved-perf-share-"));
    try {
      const needles = ["one two three", "four five six", "seven eight n", "nine ten elve"];
      const content = `head\n${"filler filler\n".repeat(30)}${needles.join("\n")}\n`;
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs/share.md"), content);
      const spans = needles.map((needle) => span(2, 13, sha256(needle)));
      const byHash = new Map(needles.map((needle) => [sha256(needle), needle]));
      const observations: MovedSearchObservation[] = [];
      const report = await verifyProofFiles(root, [{ path: "docs/share.md", after: sha256(content), spans }], {
        onSearch: (observation) => observations.push(observation),
      });
      const contentPoints = Array.from(content);
      assert.equal(observations.length, needles.length, "one search per span the file cannot place");
      assert.deepEqual(
        report[0]!.issues,
        referenceIssues("docs/share.md", content, spans),
        "the shared-index report is the per-offset report",
      );
      assert.deepEqual(
        moves(report, "docs/share.md"),
        needles.map((_, order) => [32 + order, 1, 32 + order, 13]),
      );
      observations.forEach((observation, order) => {
        assert.equal(observation.codePoints, contentPoints.length, "the file is measured, not rescanned");
        assert.equal(observation.result.outcome, "found");
        assert.equal(
          textAt(contentPoints, observation.result.position!),
          byHash.get(observation.span.hash),
          `span ${order}: the reported position holds other text`,
        );
        assert.ok(observation.result.scannedOffsets <= observation.codePoints, "one linear pass per span");
        assert.equal(observation.lineIndexBuilds, 1, `span ${order}: the position table was rebuilt`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "an input beyond a documented cap falls back instead of searching",
  { timeout: HANG_TIMEOUT_MS },
  async () => {
    const short = new MovedTextIndex("a".repeat(4_096));

    // A span too long to locate, and one too short to name, cost nothing at all.
    for (const length of [0, MOVED_SPAN_CODE_POINTS + 1]) {
      assert.deepEqual(short.search(length, sha256("aaa")), {
        outcome: "capped",
        cap: "span-length",
        scannedOffsets: 0,
        confirmations: 0,
        candidateCodePoints: 0,
      });
    }

    // A file over the scan cap is measured and refused: no code-point array, no window, no hash.
    const huge = new MovedTextIndex("z".repeat(MOVED_SCAN_CODE_POINTS + 1));
    assert.equal(huge.codePoints, MOVED_SCAN_CODE_POINTS + 1);
    assert.deepEqual(huge.search(16, sha256("zzzzzzzzzzzzzz")), {
      outcome: "capped",
      cap: "scan-size",
      scannedOffsets: 0,
      confirmations: 0,
      candidateCodePoints: 0,
    });
    assert.equal(huge.lineIndexBuilds, 0, "a refused scan builds no index at all");

    // Past the confirmation cap the search stops where it is, having done only its bounded work.
    const next = random(20261129);
    const alphabet = Array.from("abcdefghijklmnopqrstuvwxyz0123456789");
    let distinct = "";
    while (distinct.length < MOVED_CANDIDATE_CONFIRMATIONS + 4_000) {
      distinct += alphabet[Math.floor(next() * alphabet.length)]!;
    }
    const overBudget = new MovedTextIndex(distinct).search(8, sha256("zzzzzzzz"));
    assert.equal(overBudget.outcome, "capped");
    assert.equal(overBudget.cap, "confirmations");
    assert.equal(overBudget.confirmations, MOVED_CANDIDATE_CONFIRMATIONS, "the documented cap is the bound");
    assert.equal(overBudget.candidateCodePoints, MOVED_CANDIDATE_CONFIRMATIONS * 8);
    assert.ok(overBudget.scannedOffsets < Array.from(distinct).length, "the search stopped before the text ended");

    // A caller-tightened cap is respected exactly, and the same text with room to spare is searched.
    const tightened = new MovedTextIndex(distinct).search(8, sha256("zzzzzzzz"), { maxCandidateConfirmations: 64 });
    assert.deepEqual(
      { outcome: tightened.outcome, cap: tightened.cap, confirmations: tightened.confirmations },
      { outcome: "capped", cap: "confirmations", confirmations: 64 },
    );
    const withNeedle = `${distinct.slice(0, 6_000)}k3q9z1mp`;
    const located = new MovedTextIndex(withNeedle).search(8, sha256("k3q9z1mp"), {
      maxCandidateConfirmations: 8_000,
    });
    assert.equal(located.outcome, "found");
    assert.deepEqual(located.position, referenceMoved(withNeedle, 8, sha256("k3q9z1mp")));
    assert.equal(located.confirmations, 6_001, "every distinct window cost exactly one confirmation");

    // The code-point budget bounds a long span's confirmations just as strictly.
    const longSpan = new MovedTextIndex(`${"q".repeat(9_000)}w${"e".repeat(9_000)}`);
    const budgeted = longSpan.search(200, sha256("we".repeat(100)), { maxCandidateCodePoints: 4_000 });
    assert.equal(budgeted.outcome, "capped");
    assert.equal(budgeted.cap, "candidate-code-points");
    assert.equal(budgeted.confirmations, 20);
    assert.equal(budgeted.candidateCodePoints, 4_000);

    // Beyond the documented span cap the file check still answers with the code it always used, and it
    // does so without touching a single window.
    const root = mkdtempSync(join(tmpdir(), "moved-perf-cap-"));
    try {
      const content = `${"n".repeat(MOVED_SPAN_CODE_POINTS + 2)}\nfiller\n`;
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs/big.md"), content);
      const spans = [span(1, MOVED_SPAN_CODE_POINTS + 2, sha256("needle".repeat(16_667)))];
      const observed: MovedSearchObservation[] = [];
      const report = await verifyProofFiles(root, [{ path: "docs/big.md", after: sha256(content), spans }], {
        onSearch: (observation) => observed.push(observation),
      });
      assert.deepEqual(
        report[0]!.issues.map((issue) => [issue.code, issue.foundLine ?? null]),
        [["verify.span.hash", null]],
        "a span past the caps is a hash mismatch, never a move",
      );
      assert.deepEqual(report[0]!.issues, referenceIssues("docs/big.md", content, spans));
      assert.deepEqual(observed[0]!.result, {
        outcome: "capped",
        cap: "span-length",
        scannedOffsets: 0,
        confirmations: 0,
        candidateCodePoints: 0,
      });

      // A move the default caps do reach is reported with its coordinates.
      const small = "one two three\nfour five six\nneedle sits here\n";
      writeFileSync(join(root, "docs/small.md"), small);
      const smallSpans = [span(1, 9, sha256("sits here"))];
      const unrestricted = await verifyProofFiles(root, [
        { path: "docs/small.md", after: sha256(small), spans: smallSpans },
      ]);
      assert.deepEqual(
        unrestricted[0]!.issues.map((issue) => [issue.code, issue.foundLine, issue.foundColumn]),
        [["verify.span.moved", 3, 8]],
        "the default caps still locate the move",
      );
      assert.deepEqual(unrestricted[0]!.issues, referenceIssues("docs/small.md", small, smallSpans));

      // Every cap, reached through the public path, falls back to the hash code and does no more work.
      for (const [limits, cap] of [
        [{ maxSpanCodePoints: 8 }, "span-length"],
        [{ maxCandidateConfirmations: 1 }, "confirmations"],
        [{ maxCandidateCodePoints: 8 }, "candidate-code-points"],
        [{ maxScanCodePoints: 8 }, "scan-size"],
      ] as const) {
        const seen: MovedSearchObservation[] = [];
        const capped = await verifyProofFiles(
          root,
          [{ path: "docs/small.md", after: sha256(small), spans: smallSpans }],
          { ...limits, onSearch: (observation) => seen.push(observation) },
        );
        assert.deepEqual(
          capped[0]!.issues.map((issue) => issue.code),
          ["verify.span.hash"],
          `${cap}: a capped search reports a hash mismatch, never a move`,
        );
        assert.deepEqual(
          { outcome: seen[0]!.result.outcome, cap: seen[0]!.result.cap },
          { outcome: "capped", cap },
          `${cap}: the observer names the cap that stopped it`,
        );
        assert.equal(seen[0]!.result.position, undefined);
        assert.ok(seen[0]!.result.confirmations <= 1, `${cap}: more hashing than the cap allows`);
        assert.ok(seen[0]!.result.candidateCodePoints <= 9, `${cap}: more text than one window of the recorded span`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the same input always gives the same answer",
  { timeout: HANG_TIMEOUT_MS },
  async () => {
    const needle = "the moved block, late in a large file\n";
    const needlePoints = Array.from(needle).length;
    const text = `${"y".repeat(60_000)}${needle}`;
    const hash = sha256(needle);
    const index = new MovedTextIndex(text);
    const first = index.search(needlePoints, hash);
    assert.equal(first.outcome, "found");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(new MovedTextIndex(text).search(needlePoints, hash), first);
      assert.deepEqual(index.search(needlePoints, hash), first);
    }
    // The counters are part of the answer, so an identical input costs an identical search.
    assert.equal(first.confirmations, new MovedTextIndex(text).search(needlePoints, hash).confirmations);
    assert.equal(first.candidateCodePoints, index.search(needlePoints, hash).candidateCodePoints);

    // The file report is stable too, and every code it names is the contract's.
    const root = mkdtempSync(join(tmpdir(), "moved-perf-determinism-"));
    try {
      const content = "alpha\nworld\nabc abc abc\n";
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs/a.md"), content);
      const files: ProofFileEvidence[] = [
        {
          path: "docs/a.md",
          after: sha256(content),
          spans: [span(1, 5, sha256("world")), span(1, 4, sha256("nope")), span(3, 7, sha256("alpha\nw"))],
        },
      ];
      const once = await verifyProofFiles(root, files);
      const twice = await verifyProofFiles(root, [...files]);
      assert.deepEqual(twice, once);
      assert.deepEqual(once[0]!.issues, referenceIssues("docs/a.md", content, files[0]!.spans!));
      // Sorted by position: the absent needle, the move to line 2, and a move ending on line 2.
      assert.deepEqual(
        once[0]!.issues.map((issue) => [
          issue.code,
          issue.foundLine ?? null,
          issue.foundColumn ?? null,
          issue.foundEndLine ?? null,
          issue.foundEndColumn ?? null,
        ]),
        [
          ["verify.span.hash", null, null, null, null],
          ["verify.span.moved", 2, 1, 2, 5],
          ["verify.span.moved", 1, 1, 2, 1],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
