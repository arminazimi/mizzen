import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { reviewers, UNKNOWN, type Review } from "../src/model/reviewers.ts";

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
  const email = commit.email ?? "review@example.com";
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
  const root = mkdtempSync(join(tmpdir(), "reviewers-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "review@example.com"], { cwd: root });
  for (const commit of commits) commitAt(root, commit);
  return root;
}

/** Runs a test body in a fresh repository and removes it afterwards, even when the body throws. */
async function withRepository(commits: readonly Commit[], body: (root: string) => void): Promise<void> {
  const root = repository(commits);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a committed file reports the date and author of its last commit", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository([{ path: "guide/install.md", date: "2026-10-05T12:00:00Z", author: "Ada Lovelace" }], (root) => {
    assert.deepEqual(reviewers(root, "guide/install.md"), {
      date: "2026-10-05T12:00:00.000Z",
      author: "Ada Lovelace",
    });
  });
});

test("the last of several commits to one file wins", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository(
    [
      { path: "guide/install.md", date: "2026-09-01T10:00:00Z", author: "First Writer" },
      { path: "guide/install.md", date: "2026-10-02T10:00:00Z", author: "Second Writer" },
    ],
    (root) => {
      assert.deepEqual(reviewers(root, "guide/install.md"), {
        date: "2026-10-02T10:00:00.000Z",
        author: "Second Writer",
      });
    },
  );
});

test("a .mailmap remaps the author name, and the date is a canonical UTC instant", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository(
    [
      {
        path: ".mailmap",
        date: "2026-09-01T10:00:00Z",
        text: "New Name <new@example.com> <old@example.com>\n",
      },
      {
        path: "guide/install.md",
        date: "2026-10-05T12:00:00+03:30",
        author: "Old Name",
        email: "old@example.com",
      },
    ],
    (root) => {
      assert.deepEqual(reviewers(root, "guide/install.md"), {
        date: "2026-10-05T08:30:00.000Z",
        author: "New Name",
      });
    },
  );
});

test("an untracked file has no history", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository([{ path: "guide/tracked.md", date: "2026-10-05T12:00:00Z" }], (root) => {
    writeFileSync(join(root, "guide/untracked.md"), "# Untracked\n");
    assert.equal(reviewers(root, "guide/untracked.md"), UNKNOWN);
  });
});

test("a folder outside any git work tree is unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewers-plain-"));
  try {
    writeFileSync(join(root, "page.md"), "# Page\n");
    assert.equal(reviewers(root, "page.md"), UNKNOWN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file in a nested folder is found by its root-relative path", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository([{ path: "guide/deep/install.md", date: "2026-10-05T12:00:00Z", author: "Nested" }], (root) => {
    assert.deepEqual(reviewers(root, "guide/deep/install.md"), {
      date: "2026-10-05T12:00:00.000Z",
      author: "Nested",
    });
  });
});

test("each root is read once, so a later commit is not seen", { skip: hasGit ? false : "git is not installed" }, async () => {
  const root = repository([
    { path: "a.md", date: "2026-09-01T10:00:00Z", author: "First Writer" },
    { path: "b.md", date: "2026-09-01T10:00:00Z", author: "First Writer" },
  ]);
  try {
    assert.deepEqual(reviewers(root, "a.md"), { date: "2026-09-01T10:00:00.000Z", author: "First Writer" });

    commitAt(root, { path: "a.md", date: "2026-10-02T10:00:00Z", author: "Second Writer" });
    commitAt(root, { path: "b.md", date: "2026-10-02T10:00:00Z", author: "Second Writer" });

    assert.deepEqual(
      reviewers(root, "a.md"),
      { date: "2026-09-01T10:00:00.000Z", author: "First Writer" },
      "the root was already read, so the first answers are cached",
    );
    assert.deepEqual(
      reviewers(root, "b.md"),
      { date: "2026-09-01T10:00:00.000Z", author: "First Writer" },
      "the whole root is read with one git log, so b.md does not see the new commit either",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path outside the root never borrows another file's history", { skip: hasGit ? false : "git is not installed" }, async () => {
  const root = repository([{ path: "escape.md", date: "2026-10-05T12:00:00Z", author: "Outside" }]);
  const site = join(root, "site");
  try {
    mkdirSync(site, { recursive: true });
    assert.equal(reviewers(site, "../escape.md"), UNKNOWN);
    assert.equal(reviewers(site, "site/../escape.md"), UNKNOWN);
    assert.equal(reviewers(site, join(root, "escape.md")), UNKNOWN);
    assert.equal(reviewers(site, ""), UNKNOWN);
    assert.equal(reviewers(site, "."), UNKNOWN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the answer is the same on every call for a fixed repository", { skip: hasGit ? false : "git is not installed" }, async () => {
  await withRepository([{ path: "guide/install.md", date: "2026-10-05T12:00:00Z", author: "Ada Lovelace" }], (root) => {
    const first = reviewers(root, "guide/install.md") as Review;
    assert.deepEqual(reviewers(root, "guide/install.md"), first);
  });
});
