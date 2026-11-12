import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { reviewCoverage, reviewHistory, reviewers, UNKNOWN, type ReviewWindow } from "../src/model/reviewers.ts";

const hasGit = !spawnSync("git", ["--version"]).error;

/** One commit: a file, its text, and who wrote it when. */
interface Commit {
  readonly path: string;
  /** The committer date, as `GIT_COMMITTER_DATE` reads it. */
  readonly date: string;
  readonly author?: string;
  readonly email?: string;
  /** The file's text; by default a heading naming the path. */
  readonly text?: string;
}

/** Writes and commits one file in `root`. */
function commitAt(root: string, commit: Commit): void {
  const path = join(root, commit.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, commit.text ?? `# ${commit.path}\n\n${commit.date}\n`);
  execFileSync("git", ["add", "--", commit.path], { cwd: root });
  const author = commit.author ?? "Review Test";
  const email = commit.email ?? "refresh@example.com";
  execFileSync("git", ["commit", "-q", "-m", commit.path], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: commit.date,
    },
  });
}

/** A temporary git repository with `commits` made in order; the caller removes it. */
function repository(commits: readonly Commit[]): string {
  const root = mkdtempSync(join(tmpdir(), "reviewers-refresh-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Refresh Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "refresh@example.com"], { cwd: root });
  for (const commit of commits) commitAt(root, commit);
  return root;
}

/** A closed window over the fixed dates the fixtures commit at. */
function windowOf(since: string, until: string): ReviewWindow {
  return { since: new Date(since), until: new Date(until) };
}

/** Runs `body` with a `git` shim on PATH, and returns the `git log` calls it recorded. */
function withLoggedGit<T>(body: (logs: () => string[]) => T): T {
  const bin = mkdtempSync(join(tmpdir(), "reviewers-refresh-bin-"));
  const log = join(bin, "calls.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(bin, "git"), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, `exec '${realGit}' "$@"`, ""].join("\n"));
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    return body(() =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((call) => call.startsWith("log ")),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("a commit in the same root is seen by the next lookup, without restarting the process", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = repository([{ path: "guide/install.md", date: "2026-09-01T10:00:00Z", author: "First Writer" }]);
  try {
    assert.deepEqual(reviewers(root, "guide/install.md"), {
      date: "2026-09-01T10:00:00.000Z",
      author: "First Writer",
    });

    commitAt(root, { path: "guide/install.md", date: "2026-10-02T10:00:00Z", author: "Second Writer" });

    assert.deepEqual(
      reviewers(root, "guide/install.md"),
      { date: "2026-10-02T10:00:00.000Z", author: "Second Writer" },
      "HEAD moved, so the cached reviewer must not name the old commit",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page tracked by a new commit reads recorded, and its reviewer and coverage agree", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = repository([{ path: "guide/install.md", date: "2026-09-01T10:00:00Z", author: "First Writer" }]);
  try {
    writeFileSync(join(root, "guide/new.md"), "# New\n");
    assert.equal(reviewCoverage(root, "guide/new.md"), "untracked");
    assert.equal(reviewers(root, "guide/new.md"), UNKNOWN);

    commitAt(root, { path: "guide/new.md", date: "2026-10-03T10:00:00Z", author: "Third Writer" });

    assert.equal(reviewCoverage(root, "guide/new.md"), "recorded", "a newly tracked page is not still untracked");
    assert.deepEqual(
      reviewers(root, "guide/new.md"),
      { date: "2026-10-03T10:00:00.000Z", author: "Third Writer" },
      "the same state answers both lookups",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a window query sees the commit that moved HEAD", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = repository([{ path: "a.md", date: "2026-09-01T10:00:00Z", author: "First Writer" }]);
  const window = windowOf("2026-08-01T00:00:00Z", "2026-12-01T00:00:00Z");
  try {
    const before = reviewHistory(root, "a.md", window);
    assert.equal(before.commits.length, 1);
    assert.deepEqual(before.reviewers, ["First Writer"]);

    commitAt(root, { path: "a.md", date: "2026-11-01T10:00:00Z", author: "Second Writer" });

    const after = reviewHistory(root, "a.md", window);
    assert.deepEqual(
      after.commits.map((commit) => commit.author),
      ["Second Writer", "First Writer"],
      "newest first, and the new commit is inside the same window",
    );
    assert.deepEqual(after.reviewers, ["First Writer", "Second Writer"]);
    assert.deepEqual(after.lastReview, { date: "2026-11-01T10:00:00.000Z", author: "Second Writer" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two windows and the last review are read from one HEAD, never from two", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = repository([{ path: "a.md", date: "2026-09-01T10:00:00Z", author: "First Writer" }]);
  const oldWindow = windowOf("2026-08-01T00:00:00Z", "2026-09-30T00:00:00Z");
  const newWindow = windowOf("2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z");
  try {
    assert.deepEqual(reviewHistory(root, "a.md", oldWindow).commits.map((commit) => commit.author), ["First Writer"]);
    const beforeNew = reviewHistory(root, "a.md", newWindow);
    assert.equal(beforeNew.coverage, "recorded", "an older commit still names the page");
    assert.deepEqual(beforeNew.commits, []);
    assert.deepEqual(beforeNew.lastReview, { date: "2026-09-01T10:00:00.000Z", author: "First Writer" });

    commitAt(root, { path: "a.md", date: "2026-11-01T10:00:00Z", author: "Second Writer" });

    // Each window is re-read from the new state, and keeps its own bounds rather than borrowing the other's entry.
    const stillOld = reviewHistory(root, "a.md", oldWindow);
    assert.deepEqual(
      stillOld.commits.map((commit) => commit.author),
      ["First Writer"],
      "a window still filters by its own bounds",
    );
    assert.deepEqual(stillOld.reviewers, ["First Writer"]);

    const movedNew = reviewHistory(root, "a.md", newWindow);
    assert.deepEqual(
      movedNew.commits.map((commit) => commit.author),
      ["Second Writer"],
      "the entry cached under the old HEAD is gone, so the new commit is inside this window",
    );
    assert.equal(reviewCoverage(root, "a.md"), "recorded");
    assert.deepEqual(
      reviewers(root, "a.md"),
      movedNew.lastReview,
      "last review, coverage, and the window all name the same HEAD",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder that becomes a work tree is available on the next lookup", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = mkdtempSync(join(tmpdir(), "reviewers-refresh-plain-"));
  try {
    writeFileSync(join(root, "page.md"), "# Page\n");
    assert.equal(reviewers(root, "page.md"), UNKNOWN);
    assert.equal(reviewCoverage(root, "page.md"), "unavailable");
    assert.equal(reviewHistory(root, "page.md", windowOf("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z")).coverage, "unavailable");

    execFileSync("git", ["init", "-q"], { cwd: root });
    commitAt(root, { path: "page.md", date: "2026-10-04T10:00:00Z", author: "Now Tracked" });

    assert.equal(reviewCoverage(root, "page.md"), "recorded", "the unavailable answer must not be cached forever");
    assert.deepEqual(
      reviewers(root, "page.md"),
      { date: "2026-10-04T10:00:00.000Z", author: "Now Tracked" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository that leaves git again reads unavailable", { skip: hasGit ? false : "git is not installed" }, () => {
  const root = repository([{ path: "page.md", date: "2026-10-04T10:00:00Z", author: "First Writer" }]);
  try {
    assert.equal(reviewCoverage(root, "page.md"), "recorded");
    rmSync(join(root, ".git"), { recursive: true, force: true });

    assert.equal(reviewers(root, "page.md"), UNKNOWN, "the recorded answer must not outlive the repository");
    assert.equal(reviewCoverage(root, "page.md"), "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fixed HEAD keeps one whole-root log and one window log for every page", {
  skip: hasGit && process.platform !== "win32" ? false : "git and a POSIX shell are required",
}, () => {
  const root = repository([
    { path: "a.md", date: "2026-09-01T10:00:00Z", author: "First Writer" },
    { path: "b.md", date: "2026-09-02T10:00:00Z", author: "First Writer" },
    { path: "c.md", date: "2026-09-03T10:00:00Z", author: "First Writer" },
  ]);
  const window = windowOf("2026-08-01T00:00:00Z", "2026-12-01T00:00:00Z");
  try {
    withLoggedGit((logs) => {
      for (const file of ["a.md", "b.md", "c.md"]) {
        assert.notEqual(reviewers(root, file), UNKNOWN);
        assert.equal(reviewCoverage(root, file), "recorded");
        assert.equal(reviewHistory(root, file, window).coverage, "recorded");
      }

      const first = logs();
      assert.equal(first.filter((call) => !call.includes("--since-as-filter")).length, 1, first.join("\n"));
      assert.equal(first.filter((call) => call.includes("--since-as-filter")).length, 1, first.join("\n"));

      // The same HEAD: nothing new is read.
      for (const file of ["a.md", "b.md", "c.md"]) reviewers(root, file);
      assert.equal(logs().length, first.length, "an unchanged HEAD reads no further log");

      commitAt(root, { path: "d.md", date: "2026-11-04T10:00:00Z", author: "Second Writer" });

      for (const file of ["a.md", "b.md", "c.md", "d.md"]) {
        assert.equal(reviewCoverage(root, file), "recorded");
        assert.equal(reviewHistory(root, file, window).coverage, "recorded");
      }

      const after = logs().slice(first.length);
      assert.equal(after.filter((call) => !call.includes("--since-as-filter")).length, 1, after.join("\n"));
      assert.equal(after.filter((call) => call.includes("--since-as-filter")).length, 1, after.join("\n"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing git still reports unavailable, and no log per page", {
  skip: process.platform === "win32" ? "a POSIX shell is required" : false,
}, () => {
  const root = repository([{ path: "a.md", date: "2026-09-01T10:00:00Z", author: "First Writer" }]);
  const bin = mkdtempSync(join(tmpdir(), "reviewers-refresh-nogit-bin-"));
  const originalPath = process.env.PATH;
  try {
    // A git that cannot answer anything, as a removed binary would.
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n");
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    assert.equal(reviewers(root, "a.md"), UNKNOWN);
    assert.equal(reviewCoverage(root, "a.md"), "unavailable");
    assert.equal(reviewHistory(root, "a.md", windowOf("2026-08-01T00:00:00Z", "2026-12-01T00:00:00Z")).coverage, "unavailable");
    assert.equal(reviewers(root, "a.md"), UNKNOWN, "an unavailable repository is not retried into an answer");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
