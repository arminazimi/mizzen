import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitAge } from "../src/drift/git-age.ts";

const hasGit = !spawnSync("git", ["--version"]).error;

/** Writes `path` under `root` and commits it at `date`; the caller owns `root`. */
function commit(root: string, path: string, date: string, contents = `# ${path}\n`): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  execFileSync("git", ["add", "--", path], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", path], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

/** A temporary git repository with `files` committed at the given committer dates; the caller removes it. */
function repository(files: readonly { readonly path: string; readonly date: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "git-age-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Git Age Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "git-age@example.com"], { cwd: root });
  for (const file of files) commit(root, file.path, file.date);
  return root;
}

/** A temporary folder that is not a work tree; the caller removes it. */
function outside(): string {
  return mkdtempSync(join(tmpdir(), "git-age-outside-"));
}

test(
  "newer code than the page counts the whole days between the two commits",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-11T10:00:00Z" },
    ]);
    try {
      const age = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.days, 10);
      assert.equal(age.pageDate.toISOString(), "2026-09-01T10:00:00.000Z");
      assert.equal(age.codeDate.toISOString(), "2026-09-11T10:00:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "older code than the page gives a negative age",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-11T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-01T10:00:00Z" },
    ]);
    try {
      const age = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.days, -10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a page and code committed the same day are zero days apart",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T08:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-01T20:00:00Z" },
    ]);
    try {
      const age = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.days, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the newest referenced file wins among several, in nested folders",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "docs/guide/nested/page.md", date: "2026-01-01T00:00:00Z" },
      { path: "src/deep/a.ts", date: "2026-01-05T00:00:00Z" },
      { path: "src/deep/b.ts", date: "2026-01-03T00:00:00Z" },
    ]);
    try {
      const age = gitAge(root, "docs/guide/nested/page.md", ["src/deep/b.ts", "src/deep/a.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.days, 4);
      assert.equal(age.codeDate.toISOString(), "2026-01-05T00:00:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("no referenced files gives unknown", () => {
  assert.equal(gitAge(process.cwd(), "guide/setup.md", []), "unknown");
});

test("a folder that is not a work tree gives unknown, never an error", () => {
  const root = outside();
  try {
    assert.equal(gitAge(root, "guide/setup.md", ["src/foo.ts"]), "unknown");
    assert.equal(gitAge(join(root, "missing"), "guide/setup.md", ["src/foo.ts"]), "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a file git never committed gives unknown",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([{ path: "src/foo.ts", date: "2026-09-01T10:00:00Z" }]);
    try {
      assert.equal(gitAge(root, "guide/missing.md", ["src/foo.ts"]), "unknown");
      assert.equal(gitAge(root, "guide/missing.md", []), "unknown");
      assert.equal(gitAge(root, "src/foo.ts", ["src/missing.ts"]), "unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "repeated calls reuse the repository check and the per-path dates",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-02T10:00:00Z" },
    ]);
    try {
      const first = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      const second = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.deepEqual(second, first);
      assert.notEqual(first, "unknown");
      if (first === "unknown") return;
      assert.equal(first.days, 1);

      // The cache is per root and per state: the two calls above share it, and a new commit moves that state.
      commit(root, "src/foo.ts", "2026-10-01T10:00:00Z", "// changed\n");
      const third = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(third, "unknown");
      if (third === "unknown") return;
      assert.equal(third.days, 30);
      assert.equal(third.pageDate.toISOString(), first.pageDate.toISOString());
      assert.notDeepEqual(third, first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a page path that leaves the root is refused, and so is a reference that does",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-11T10:00:00Z" },
    ]);
    try {
      assert.equal(gitAge(root, "../outside.md", ["src/foo.ts"]), "unknown");
      assert.equal(gitAge(root, "/etc/passwd", ["src/foo.ts"]), "unknown");
      assert.equal(gitAge(root, "guide/setup.md", ["../outside.ts"]), "unknown");
      assert.equal(gitAge(root, "guide/setup.md", ["/etc/passwd"]), "unknown");

      const age = gitAge(root, "guide/setup.md", ["../outside.ts", "src/foo.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.days, 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
