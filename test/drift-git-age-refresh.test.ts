import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "git-age-refresh-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Git Age Refresh Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "git-age-refresh@example.com"], { cwd: root });
  for (const file of files) commit(root, file.path, file.date);
  return root;
}

/** A temporary folder that is not a work tree; the caller removes it. */
function outside(): string {
  return mkdtempSync(join(tmpdir(), "git-age-refresh-outside-"));
}

/** The `git log` calls (not the repository checks) recorded in a spy log. */
function dateLookups(log: string): string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => line.startsWith("log "));
}

/**
 * A `bin` folder whose `git` records every call it passes through in `log`, so the caller can count them.
 * The caller owns both `bin` and `log`, and the previous `PATH`; `restore` puts `PATH` back.
 */
function spying(bin: string, log: string): () => void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const original = process.env.PATH;
  writeFileSync(
    join(bin, "git"),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, `exec '${realGit}' "$@"`, ""].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = original === undefined ? bin : `${bin}:${original}`;
  return () => {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  };
}

test(
  "a new commit at the same root is visible to the next call",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-02T10:00:00Z" },
    ]);
    try {
      const first = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(first, "unknown");
      if (first === "unknown") return;
      assert.equal(first.days, 1);

      // The referenced code moves: the next call reports the new commit, and the page's date is untouched.
      commit(root, "src/foo.ts", "2026-10-01T10:00:00Z", "// changed\n");
      const second = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(second, "unknown");
      if (second === "unknown") return;
      assert.equal(second.codeDate.toISOString(), "2026-10-01T10:00:00.000Z");
      assert.equal(second.pageDate.toISOString(), "2026-09-01T10:00:00.000Z");
      assert.equal(second.days, 30);

      // The page moves too: both dates come from the new history.
      commit(root, "guide/setup.md", "2026-11-01T10:00:00Z", "# newer\n");
      const third = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(third, "unknown");
      if (third === "unknown") return;
      assert.equal(third.pageDate.toISOString(), "2026-11-01T10:00:00.000Z");
      assert.equal(third.codeDate.toISOString(), "2026-10-01T10:00:00.000Z");
      assert.equal(third.days, -31);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a commit that only adds a file is still a new history for the paths already asked about",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-02T10:00:00Z" },
    ]);
    try {
      const first = gitAge(root, "guide/setup.md", ["src/bar.ts"]);
      assert.equal(first, "unknown", "src/bar.ts has no commit yet");

      // HEAD moved even though neither cached path changed, so the reference is now answerable.
      commit(root, "src/bar.ts", "2026-09-20T10:00:00Z");
      const second = gitAge(root, "guide/setup.md", ["src/bar.ts"]);
      assert.notEqual(second, "unknown");
      if (second === "unknown") return;
      assert.equal(second.codeDate.toISOString(), "2026-09-20T10:00:00.000Z");
      assert.equal(second.days, 19);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "an unchanged history asks git once per path; a moved HEAD asks again",
  {
    skip:
      hasGit === false ? "git is not installed" : process.platform === "win32" ? "a POSIX shell is required" : false,
  },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-02T10:00:00Z" },
    ]);
    const bin = mkdtempSync(join(tmpdir(), "git-age-refresh-bin-"));
    const log = join(bin, "calls.log");
    writeFileSync(log, "");
    const restore = spying(bin, log);
    try {
      const first = gitAge(root, "guide/setup.md", ["src/foo.ts", "src/foo.ts"]);
      const lookups = dateLookups(log);
      assert.equal(lookups.length, 2, `one date lookup per path: ${lookups.join(" | ")}`);
      assert.equal(
        new Set(lookups.map((line) => line.split(" -- ")[1])).size,
        2,
        "the page and the reference each asked once",
      );

      // Same HEAD, same paths, even a different page: nothing is re-asked.
      writeFileSync(log, "");
      const second = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.deepEqual(second, first);
      assert.equal(dateLookups(log).length, 0, "no date lookup while HEAD is unchanged");

      writeFileSync(log, "");
      const other = gitAge(root, "guide/other.md", ["src/foo.ts"]);
      assert.equal(other, "unknown");
      const newPage = dateLookups(log);
      assert.equal(newPage.length, 1, `only the never-asked page is looked up: ${newPage.join(" | ")}`);
      assert.match(newPage[0]!, / -- guide\/other\.md$/, "the reference is reused from the unchanged history");

      // HEAD moves: the cached answers belong to the old history, so both paths are asked again, once each.
      commit(root, "src/foo.ts", "2026-10-01T10:00:00Z", "// changed\n");
      writeFileSync(log, "");
      const third = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(third, "unknown");
      if (third === "unknown") return;
      assert.equal(third.days, 30);
      const after = dateLookups(log);
      assert.equal(after.length, 2, `one re-asked lookup per path: ${after.join(" | ")}`);

      writeFileSync(log, "");
      assert.deepEqual(gitAge(root, "guide/setup.md", ["src/foo.ts"]), third);
      assert.equal(dateLookups(log).length, 0, "the refreshed answers are then cached again");
    } finally {
      restore();
      rmSync(bin, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a history that was unavailable is retried once the repository exists",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = outside();
    try {
      assert.equal(gitAge(root, "guide/setup.md", ["src/foo.ts"]), "unknown");

      // The same root, the same process, now a work tree with commits: the earlier "unknown" must not stick.
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Git Age Refresh Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "git-age-refresh@example.com"], { cwd: root });
      commit(root, "guide/setup.md", "2026-09-01T10:00:00Z");
      commit(root, "src/foo.ts", "2026-09-11T10:00:00Z");

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
  "a git call that fails gives an honest unknown, and the next call that works gives the real dates",
  {
    skip:
      hasGit === false ? "git is not installed" : process.platform === "win32" ? "a POSIX shell is required" : false,
  },
  () => {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-11T10:00:00Z" },
    ]);
    const bin = mkdtempSync(join(tmpdir(), "git-age-refresh-broken-bin-"));
    const original = process.env.PATH;
    try {
      assert.notEqual(gitAge(root, "guide/setup.md", ["src/foo.ts"]), "unknown");

      // git now fails every call: an honest unknown, never an error and never a substituted date.
      writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n");
      chmodSync(join(bin, "git"), 0o755);
      process.env.PATH = original === undefined ? bin : `${bin}:${original}`;
      assert.equal(gitAge(root, "guide/setup.md", ["src/foo.ts"]), "unknown");

      // git answers again and the history moved: the next call reads the new commits.
      writeFileSync(join(bin, "git"), ['#!/bin/sh', `exec '${realGit}' "$@"`, ""].join("\n"));
      commit(root, "src/foo.ts", "2026-10-21T10:00:00Z", "// changed\n");
      const age = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.codeDate.toISOString(), "2026-10-21T10:00:00.000Z");
      assert.equal(age.days, 50);
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
      rmSync(bin, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "refreshed dates come from commits, never from the clock or a file mtime",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-11T10:00:00Z" },
    ]);
    try {
      // mtimes say "now" and "a year ago"; git says the committed dates, and the committed dates win.
      const now = new Date();
      utimesSync(join(root, "guide/setup.md"), now, new Date(now.getTime() + 400 * 86_400_000));
      utimesSync(join(root, "src/foo.ts"), now, new Date(now.getTime() - 400 * 86_400_000));

      const first = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(first, "unknown");
      if (first === "unknown") return;
      assert.equal(first.pageDate.toISOString(), "2026-09-01T10:00:00.000Z");
      assert.equal(first.codeDate.toISOString(), "2026-09-11T10:00:00.000Z");

      commit(root, "src/foo.ts", "2026-09-12T06:00:00Z", "// changed\n");
      utimesSync(join(root, "src/foo.ts"), now, new Date("2030-01-01T00:00:00Z"));

      const second = gitAge(root, "guide/setup.md", ["src/foo.ts"]);
      assert.notEqual(second, "unknown");
      if (second === "unknown") return;
      assert.equal(second.codeDate.toISOString(), "2026-09-12T06:00:00.000Z");
      assert.equal(second.pageDate.toISOString(), "2026-09-01T10:00:00.000Z");
      assert.equal(second.days, 10, "whole days between the two commits, whatever the files claim");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "path confinement and the newest-reference rule survive a refresh",
  { skip: hasGit ? false : "git is not installed" },
  () => {
    const root = repository([
      { path: "guide/setup.md", date: "2026-09-01T10:00:00Z" },
      { path: "src/foo.ts", date: "2026-09-02T10:00:00Z" },
    ]);
    try {
      gitAge(root, "guide/setup.md", ["src/foo.ts"]);

      commit(root, "src/deep/b.ts", "2026-12-01T10:00:00Z");
      commit(root, "src/deep/a.ts", "2026-12-05T10:00:00Z");

      assert.equal(gitAge(root, "../outside.md", ["src/foo.ts"]), "unknown");
      assert.equal(gitAge(root, "/etc/passwd", ["src/foo.ts"]), "unknown");

      const age = gitAge(root, "guide/setup.md", ["../outside.ts", "/etc/passwd", "src/deep/b.ts", "src/deep/a.ts"]);
      assert.notEqual(age, "unknown");
      if (age === "unknown") return;
      assert.equal(age.codeDate.toISOString(), "2026-12-05T10:00:00.000Z", "the newest reference still wins");
      assert.equal(age.days, 95);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
