/**
 * Issue #98 (M2.10): an edit write stays inside the site root once symlinks are in play.
 *
 * `writeFilePatches` has always refused a path that *looks* like it leaves the root. These tests
 * cover what a lexical check cannot see: a parent directory that is a symlink out of the root, a
 * target that is itself a symlink (escaping, in-root, or dangling), and a parent swapped for an
 * escaping symlink after the edit was staged. They also pin the parts of the writer that must not
 * change: a refusal is atomic across the whole set and cleans every staging folder, while ordinary
 * files, nested folders, an in-root symlinked parent and a symlinked site root still apply with the
 * same bytes, the same mode, and hashes that match what the tree now holds. Every fixture — the
 * site root and everything outside it — lives in a temp folder this file creates and removes; the
 * only "external" file is a sibling of the root, never a real one.
 *
 * macOS makes `/var` a symlink to `/private/var`, so a temp root is already "outside" its own
 * realpath unless both sides are compared resolved; the tests therefore compare realpaths, the same
 * way the implementation does.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  EditFileError,
  hashSource,
  writeFilePatches,
  type EditFile,
  type Patch,
  type PatchSpan,
} from "../src/edits/patch.ts";

/** A span on one line. */
function span(line: number, column: number, endLine: number, endColumn: number, file?: string): PatchSpan {
  return file === undefined ? { line, column, endLine, endColumn } : { file, line, column, endLine, endColumn };
}

/** A patch carrying both preconditions, as a plan does. */
function planned(source: string, at: PatchSpan, replacement: string, expected: string): Patch {
  return { span: at, replacement, expected, beforeHash: hashSource(source) };
}

/** The `# Old` edit a plan would carry for a file whose source is `source`. */
function oldToNew(source: string, file: string): Patch {
  return planned(source, span(1, 3, 1, 5, file), "New", "Old");
}

/**
 * A temp tree holding `files`, removed by the caller. Returns its parent, so a test can point a
 * symlink at a path that sits outside `parent/site`.
 */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "edits-patch-symlink-"));
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/** Every `.edit-*` staging folder left anywhere under `dir`, followed through real directories only. */
function stagingLeftovers(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // a link is never walked; the test follows the real tree
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".edit-")) found.push(path);
    found.push(...stagingLeftovers(path));
  }
  return found;
}

/** The tree's files, keyed by relative path, for a byte-for-byte comparison. */
function snapshot(root: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

/** The error a refused edit must be: a `path-escape` refusal naming the file the edit asked for. */
function isPathEscape(file: string) {
  return (error: unknown): boolean =>
    error instanceof EditFileError && error.code === "path-escape" && error.file === file;
}

test("a parent symlink that leaves the site root is refused before its file is read", async () => {
  const parent = tree({
    "outside/nested/a.md": "# Old\n",
    "site/docs/.keep": "",
  });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside", "nested"), join(site, "nested"), "dir");
  const edit: EditFile[] = [{ file: "nested/a.md", patches: [oldToNew("# Old\n", "nested/a.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("nested/a.md"));
    assert.equal(
      readFileSync(join(parent, "outside", "nested", "a.md"), "utf8"),
      "# Old\n",
      "the file outside the root was not written",
    );
    assert.deepEqual(stagingLeftovers(parent), [], "no staging folder was left behind");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the escaping parent is refused before its bytes are read, not after a failed precondition", async () => {
  // The file outside the root deliberately breaks the patch's preconditions. A writer that read the
  // path and checked containment afterwards would report the stale hash; only a writer that never
  // reads an escaping path reports `path-escape`, so the code below proves the read never happened.
  const parent = tree({
    "outside/nested/a.md": "# Different\n",
    "site/docs/.keep": "",
  });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside", "nested"), join(site, "nested"), "dir");
  const edit: EditFile[] = [{ file: "nested/a.md", patches: [oldToNew("# Old\n", "nested/a.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("nested/a.md"));
    assert.equal(readFileSync(join(parent, "outside", "nested", "a.md"), "utf8"), "# Different\n");
    assert.deepEqual(stagingLeftovers(parent), [], "a refusal that never read the path never stages either");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a symlink in the middle of a nested path cannot lead the edit out of the root", async () => {
  const parent = tree({
    "outside/deep/b.md": "# Old\n",
    "site/docs/keep.md": "# Old\n",
  });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside", "deep"), join(site, "docs", "linkdir"), "dir");
  const edit: EditFile[] = [{ file: "docs/linkdir/b.md", patches: [oldToNew("# Old\n", "docs/linkdir/b.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("docs/linkdir/b.md"));
    assert.equal(readFileSync(join(parent, "outside", "deep", "b.md"), "utf8"), "# Old\n");
    assert.equal(readFileSync(join(site, "docs", "keep.md"), "utf8"), "# Old\n");
    assert.deepEqual(stagingLeftovers(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a target symlink that leaves the site root is refused, and its real file is never touched", async () => {
  const parent = tree({ "outside.md": "# Old\n", "site/docs/.keep": "" });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside.md"), join(site, "docs", "link.md"));
  const edit: EditFile[] = [{ file: "docs/link.md", patches: [oldToNew("# Old\n", "docs/link.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("docs/link.md"));
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(lstatSync(join(site, "docs", "link.md")).isSymbolicLink(), true);
    assert.deepEqual(stagingLeftovers(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an existing target symlink is refused as ambiguous even when it stays inside the root", async () => {
  const source = "one\r\n# Old\r\nthree\r\n";
  const parent = tree({ "site/shared/real.md": source, "site/docs/.keep": "" });
  const site = join(parent, "site");
  const link = join(site, "docs", "link.md");
  symlinkSync(join("..", "shared", "real.md"), link);
  const edit: EditFile[] = [
    {
      file: "docs/link.md",
      patches: [planned(source, span(2, 3, 2, 5, "docs/link.md"), "New", "Old")],
    },
  ];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("docs/link.md"));
    // Renaming onto a link replaces the link; reading follows it. The two disagree, so nothing runs.
    assert.equal(readFileSync(join(site, "shared", "real.md"), "utf8"), source, "the link's file is unchanged");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still a link");
    assert.deepEqual(stagingLeftovers(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a dangling symlink in the root is refused as ambiguous instead of reported as a missing file", async () => {
  // An existing link that points at nothing is still ambiguous: reading follows it and fails,
  // renaming replaces the link with a file. The refusal is the containment one, not `source-missing`.
  const parent = tree({ "site/docs/.keep": "" });
  const site = join(parent, "site");
  const link = join(site, "docs", "gone.md");
  symlinkSync(join("..", "missing.md"), link);
  const edit: EditFile[] = [{ file: "docs/gone.md", patches: [oldToNew("# Old\n", "docs/gone.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("docs/gone.md"));
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still a link");
    assert.equal(existsSync(join(site, "missing.md")), false, "no file appeared where the link pointed");
    assert.deepEqual(stagingLeftovers(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("one escaping path refuses a whole multi-file edit, leaving every file and folder as found", async () => {
  const before = { "docs/a.md": "# Old\n", "docs/b.md": "body\n", "shared/c.md": "# Old\n" };
  const parent = tree({
    "outside/c.md": before["shared/c.md"],
    "site/docs/a.md": before["docs/a.md"],
    "site/docs/b.md": before["docs/b.md"],
    "site/shared/c.md": before["shared/c.md"],
  });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside"), join(site, "escape"), "dir");
  const edit: EditFile[] = [
    { file: "docs/a.md", patches: [oldToNew(before["docs/a.md"]!, "docs/a.md")] },
    {
      file: "docs/b.md",
      patches: [planned(before["docs/b.md"]!, span(1, 1, 1, 4, "docs/b.md"), "text", "body")],
    },
    { file: "escape/c.md", patches: [oldToNew(before["shared/c.md"]!, "escape/c.md")] },
  ];
  const paths = Object.keys(before);
  try {
    await assert.rejects(writeFilePatches(site, edit), isPathEscape("escape/c.md"));
    assert.deepEqual(snapshot(site, paths), before, "the whole edit set left the tree untouched");
    assert.equal(readFileSync(join(parent, "outside", "c.md"), "utf8"), "# Old\n", "nothing landed outside");
    assert.deepEqual(stagingLeftovers(parent), [], "a refusal leaves no staging folder behind");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a parent swapped for an escaping symlink after staging cannot redirect the commit", async () => {
  const parent = tree({ "site/nested/a.md": "# Old\n", "outside/nested/a.md": "# Old\n" });
  const site = join(parent, "site");
  const outside = join(parent, "outside", "nested", "a.md");
  const edit: EditFile[] = [{ file: "nested/a.md", patches: [oldToNew("# Old\n", "nested/a.md")] }];
  // The swapped-in file has the same bytes, so only the real-path check at commit time can see it.
  let stagedFolders: string[] = [];
  const hooks = {
    beforeCommit: async (): Promise<void> => {
      // Record the folders the edit created, so the refusal below is checked against a swap that
      // really did happen between staging and commit.
      stagedFolders = stagingLeftovers(site);
      rmSync(join(site, "nested"), { recursive: true, force: true });
      symlinkSync(join(parent, "outside", "nested"), join(site, "nested"), "dir");
    },
  };
  try {
    await assert.rejects(writeFilePatches(site, edit, {}, hooks), isPathEscape("nested/a.md"));
    assert.ok(stagedFolders.length > 0, "the edit was staged before the parent was swapped");
    assert.equal(readFileSync(outside, "utf8"), "# Old\n", "the rename never reached the file outside");
    assert.deepEqual(stagingLeftovers(join(parent, "outside")), []);
    assert.deepEqual(stagingLeftovers(site), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a parent swapped before staging is refused before any staging folder exists outside the root", async () => {
  // Staging gets its own boundary check: the bytes of an edit must never be written beside a path
  // that resolves outside the root, not even in a folder the refusal then deletes. `beforeCommit`
  // only runs if a staging folder was created, so what it sees outside the root is the evidence.
  const parent = tree({ "site/nested/a.md": "# Old\n", "outside/nested/a.md": "# Old\n" });
  const site = join(parent, "site");
  const outsideDir = join(parent, "outside", "nested");
  const stagedOutside: string[] = [];
  const hooks = {
    beforeStage: (): void => {
      rmSync(join(site, "nested"), { recursive: true, force: true });
      symlinkSync(outsideDir, join(site, "nested"), "dir");
    },
    beforeCommit: (): void => {
      stagedOutside.push(...stagingLeftovers(outsideDir));
    },
  };
  const edit: EditFile[] = [{ file: "nested/a.md", patches: [oldToNew("# Old\n", "nested/a.md")] }];
  try {
    await assert.rejects(writeFilePatches(site, edit, {}, hooks), isPathEscape("nested/a.md"));
    assert.deepEqual(stagedOutside, [], "no staging folder was ever created outside the site root");
    assert.equal(readFileSync(join(outsideDir, "a.md"), "utf8"), "# Old\n", "the file outside is untouched");
    assert.deepEqual(stagingLeftovers(parent), [], "the refusal leaves no staging folder behind");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a commit-time refusal of a swapped parent refuses the whole set and cleans every staging folder", async () => {
  // The escaping parent belongs to one file of a two-file set. The other file was staged beside a
  // folder that the swap leaves exactly where it was, so its staging folder is still there for the
  // refusal to clean up — the check the single-file swap cannot make.
  const before = { "docs/a.md": "# Old\n", "nested/b.md": "# Old\n" };
  const parent = tree({
    "site/docs/a.md": before["docs/a.md"]!,
    "site/nested/b.md": before["nested/b.md"]!,
    "outside/nested/b.md": before["nested/b.md"]!,
  });
  const site = join(parent, "site");
  const escaped = join(parent, "outside", "nested", "b.md");
  let stagedFolders: string[] = [];
  const hooks = {
    beforeCommit: async (): Promise<void> => {
      stagedFolders = stagingLeftovers(site);
      rmSync(join(site, "nested"), { recursive: true, force: true });
      symlinkSync(join(parent, "outside", "nested"), join(site, "nested"), "dir");
    },
  };
  const edit: EditFile[] = [
    { file: "docs/a.md", patches: [oldToNew(before["docs/a.md"]!, "docs/a.md")] },
    { file: "nested/b.md", patches: [oldToNew(before["nested/b.md"]!, "nested/b.md")] },
  ];
  try {
    await assert.rejects(writeFilePatches(site, edit, {}, hooks), isPathEscape("nested/b.md"));
    assert.ok(
      stagedFolders.some((folder) => folder.includes(join("site", "docs"))),
      `the in-root file was staged before the swap; saw ${stagedFolders.join(", ")}`,
    );
    assert.deepEqual(snapshot(site, Object.keys(before)), before, "the whole edit set is refused, not one file");
    assert.equal(readFileSync(escaped, "utf8"), "# Old\n", "the rename never reached the file outside");
    assert.deepEqual(stagingLeftovers(site), [], "the staging folder the swap left reachable is cleaned up");
    assert.deepEqual(stagingLeftovers(join(parent, "outside")), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("in-root paths, nested folders and in-root symlinked parents still apply with the same bytes", async () => {
  const plain = "# Old\n";
  const crlf = "one\r\n# Old\r\nthree\r\n";
  const parent = tree({
    "site/top.md": plain,
    "site/docs/a.md": plain,
    "site/docs/sub/b.md": crlf,
    "site/shared/c.md": plain,
  });
  const site = join(parent, "site");
  symlinkSync(join(site, "shared"), join(site, "linkdir"), "dir");
  // An unusual mode on the nested file: the staged copy must carry it over, as it always has.
  chmodSync(join(site, "docs", "sub", "b.md"), 0o640);
  const edit: EditFile[] = [
    { file: "top.md", patches: [oldToNew(plain, "top.md")] },
    { file: "docs/a.md", patches: [oldToNew(plain, "docs/a.md")] },
    { file: "docs/sub/b.md", patches: [planned(crlf, span(2, 3, 2, 5, "docs/sub/b.md"), "New", "Old")] },
    { file: "linkdir/c.md", patches: [oldToNew(plain, "linkdir/c.md")] },
  ];
  // The file each result describes on disk, in the same order; the last one is reached through a link.
  const written = ["top.md", "docs/a.md", "docs/sub/b.md", "shared/c.md"];
  try {
    const results = await writeFilePatches(site, edit);
    assert.deepEqual(
      results.map((result) => result.after),
      ["# New\n", "# New\n", "one\r\n# New\r\nthree\r\n", "# New\n"],
    );
    assert.deepEqual(
      snapshot(site, ["top.md", "docs/a.md", "docs/sub/b.md", "shared/c.md"]),
      {
        "top.md": "# New\n",
        "docs/a.md": "# New\n",
        "docs/sub/b.md": "one\r\n# New\r\nthree\r\n",
        "shared/c.md": "# New\n",
      },
      "the write through an in-root symlinked parent lands in the real folder",
    );
    for (const [index, result] of results.entries()) {
      assert.equal(result.beforeHash, hashSource(result.before));
      assert.equal(result.afterHash, hashSource(result.after));
      // The bytes a proof hash are the bytes the tree holds, so the proof of this edit still verifies.
      assert.equal(result.afterHash, hashSource(readFileSync(join(site, written[index]!), "utf8")));
    }
    assert.equal(statSync(join(site, "docs", "sub", "b.md")).mode & 0o777, 0o640, "the mode is kept");
    assert.equal(realpathSync(join(site, "linkdir")), realpathSync(join(site, "shared")), "the link survives");
    assert.equal(lstatSync(join(site, "linkdir")).isSymbolicLink(), true);
    assert.deepEqual(stagingLeftovers(parent), [], "a committed edit leaves no staging folder behind");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a site root that is itself a symlink applies ordinary nested edits unchanged", async () => {
  // The real root is compared against real targets, so naming the tree through a link into it must
  // not turn a plain edit into a refusal.
  const plain = "# Old\n";
  const parent = tree({
    "site/docs/a.md": plain,
    "site/docs/sub/b.md": plain,
    "site/shared/c.md": plain,
  });
  const site = join(parent, "site");
  const asLink = join(parent, "root-link");
  symlinkSync(site, asLink, "dir");
  const edit: EditFile[] = [
    { file: "docs/a.md", patches: [oldToNew(plain, "docs/a.md")] },
    { file: "docs/sub/b.md", patches: [oldToNew(plain, "docs/sub/b.md")] },
  ];
  try {
    const results = await writeFilePatches(asLink, edit);
    assert.deepEqual(
      snapshot(site, ["docs/a.md", "docs/sub/b.md"]),
      { "docs/a.md": "# New\n", "docs/sub/b.md": "# New\n" },
      "the edit landed in the real tree",
    );
    assert.deepEqual(
      results.map((result) => result.file),
      ["docs/a.md", "docs/sub/b.md"],
      "the records name the files the edit asked for",
    );
    assert.deepEqual(stagingLeftovers(parent), [], "a committed edit leaves no staging folder behind");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
