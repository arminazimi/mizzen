import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitAge } from "../src/drift/git-age.ts";
import { reviewCoverage, reviewHistory, reviewers, UNKNOWN, type ReviewWindow } from "../src/model/reviewers.ts";

// The git calls these modules make are bounded by a deadline and an output cap. A shim stands in for git so a
// stalled or over-producing command is deterministic and needs no repository.
const posix = process.platform !== "win32";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The shim lines that answer the two `rev-parse` calls {@link gitAge} makes. */
const AGE_STATE = [
  'if [ "$1" = "rev-parse" ]; then',
  `  if [ "$2" = "HEAD" ]; then printf '${SHA}\\n'; else printf 'true\\n'; fi`,
  "  exit 0",
  "fi",
].join("\n");

/** The shim line that answers the one `rev-parse` call {@link reviewers} makes. */
const REVIEW_STATE = `if [ "$1" = "rev-parse" ]; then printf 'true\\n${SHA}\\n'; exit 0; fi`;

/** The window every review query below asks about. */
const WINDOW: ReviewWindow = { since: new Date("2026-08-01T00:00:00Z"), until: new Date("2026-12-01T00:00:00Z") };

/**
 * Runs `body` with a temporary root and a `git` shim first on PATH. An undefined `script` means there is no git at
 * all. Both folders and PATH are restored afterwards.
 */
function withGitShim(script: string | undefined, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "git-history-limits-"));
  const bin = mkdtempSync(join(tmpdir(), "git-history-limits-bin-"));
  const original = process.env.PATH;
  try {
    if (script !== undefined) {
      writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, "git"), 0o755);
    }
    process.env.PATH = original === undefined ? bin : `${bin}:${original}`;
    body(root);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("a git log that stalls reads as an unknown age instead of holding the caller", { skip: posix ? false : "a POSIX shell is required" }, () => {
  // The shim never answers: only the deadline can end the call.
  const script = [AGE_STATE, 'if [ "$1" = "log" ]; then exec sleep 30; fi', "exit 0"].join("\n");
  withGitShim(script, (root) => {
    const started = Date.now();
    assert.equal(gitAge(root, "page.md", ["src/code.ts"]), "unknown");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20_000, `a stalled git must not hold the caller: ${elapsed} ms`);
  });
});

test("a git log larger than the output cap reads as an unknown age, never a partial date", { skip: posix ? false : "a POSIX shell is required" }, () => {
  // A valid date followed by more padding than the cap allows; read in full, the padding trims away to a date.
  const script = [
    AGE_STATE,
    'if [ "$1" = "log" ]; then',
    "  printf '2026-09-01T10:00:00Z'",
    "  yes ' ' | head -c 200000",
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  withGitShim(script, (root) => {
    assert.equal(gitAge(root, "page.md", ["src/code.ts"]), "unknown");
  });
});

test("a review-window log that stalls reads as unavailable instead of holding the caller", { skip: posix ? false : "a POSIX shell is required" }, () => {
  // Only the window log stalls; the whole-root log answers instantly, so a stuck window is not hidden by a fallback.
  const script = [
    REVIEW_STATE,
    'if [ "$1" = "log" ]; then',
    '  case "$*" in *--since-as-filter*) exec sleep 30 ;; esac',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  withGitShim(script, (root) => {
    const started = Date.now();
    assert.equal(reviewHistory(root, "page.md", WINDOW).coverage, "unavailable");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20_000, `a stalled git must not hold the caller: ${elapsed} ms`);
  });
});

test("a whole-root log larger than the output cap reads as unavailable, never as an untracked page", { skip: posix ? false : "a POSIX shell is required" }, () => {
  // One valid review record, then more padding than the cap allows.
  const script = [
    REVIEW_STATE,
    'if [ "$1" = "log" ]; then',
    "  printf '\\0012026-09-01T10:00:00Z\\002Author\\000\\npage.md\\000'",
    "  yes x | head -c 40000000",
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  withGitShim(script, (root) => {
    assert.equal(reviewCoverage(root, "page.md"), "unavailable");
  });
});

test("a git that cannot start reads as unknown age and unavailable review evidence", { skip: posix ? false : "a POSIX shell is required" }, () => {
  withGitShim(undefined, (root) => {
    assert.equal(gitAge(root, "page.md", ["src/code.ts"]), "unknown");
    assert.equal(reviewers(root, "page.md"), UNKNOWN);
    assert.equal(reviewCoverage(root, "page.md"), "unavailable");
    assert.equal(reviewHistory(root, "page.md", WINDOW).coverage, "unavailable");
  });
});
