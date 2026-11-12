import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { expandIncludes, type ExpandIncludesOptions, type IncludeResult } from "../src/content/includes.ts";

/**
 * Issue #94: the include boundary has to hold for real filesystem paths, not only for the lexical path the
 * directive spells. Every outside file here lives in a temp folder this very test creates under `os.tmpdir()`
 * and nothing is read from a real user path.
 *
 * On macOS `tmpdir()` is under `/var`, which is itself a symlink to `/private/var`, so the source root this test
 * builds already contains a symlinked component. Assertions that compare canonical paths therefore canonicalize
 * both sides the same way.
 */

/** The only content of any outside file; no byte of it may reach a result. */
const SECRET = "OUTSIDE-SECRET-BYTES-8d41c0e7\n";

/** Marker substring of {@link SECRET}, so a message can stay readable. */
const MARKER = "OUTSIDE-SECRET-BYTES";

/** The temp folders this test creates, all removed at the end. */
const created: string[] = [];

/** A temporary source folder holding `files`. */
function source(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "includes-symlink-src-"));
  created.push(root);
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/** A temporary folder that is outside every source folder, holding `files`. */
function outside(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "includes-symlink-outside-"));
  created.push(root);
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/** The real path of `path`, the same way the engine canonicalizes. */
const real = (path: string): string => realpathSync(path);

/** Expands `body` of `file` under `root`, with the defaults the engine's build uses. */
function expand(root: string, file: string, body: string, extra: Partial<ExpandIncludesOptions> = {}) {
  return expandIncludes({ body, bodyLine: 1, file, sourceDir: root, ...extra });
}

/** Fails when a byte, a path or a diagnostic of the outside folder appears anywhere in `result`. */
function assertRevealsNothingOutside(result: IncludeResult, outsideRoot: string): void {
  const shown = JSON.stringify(result);
  assert.ok(!shown.includes(MARKER), `an outside byte reached the result: ${shown}`);
  for (const path of [outsideRoot, real(outsideRoot)]) {
    assert.ok(!shown.includes(path), `the outside path ${path} reached the result: ${shown}`);
  }
  // The escape is refused before the read, so the result stays small enough to reason about.
  assert.ok(result.body.length < 200, `unexpected body: ${result.body}`);
}

/** The single `include.outside-source` diagnostic, at the file and line that hold the directive. */
function assertRefused(result: IncludeResult, file: string, line: number): void {
  assert.deepEqual(
    result.diagnostics.map((d) => d.id),
    ["include.outside-source"],
    JSON.stringify(result.diagnostics),
  );
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic!.severity, "error");
  assert.equal(diagnostic!.pos?.file, file);
  assert.equal(diagnostic!.pos?.line, line);
  assert.equal(diagnostic!.pos?.column, 1);
  assert.ok(diagnostic!.help !== undefined && diagnostic!.help.length > 0, "the diagnostic must say what to do");
}

test("a direct include through a symlink out of the source folder is refused and never read", async () => {
  const out = outside({ "secret.md": SECRET });
  const root = source({ "a.md": "" });
  symlinkSync(join(out, "secret.md"), join(root, "escape.md"));
  try {
    const result = await expand(root, "a.md", "Before\n::include[escape.md]\nAfter\n");
    assertRefused(result, "a.md", 2);
    assert.equal(result.body, "Before\nAfter\n");
    // Nothing was recorded for a file that was never read.
    assert.deepEqual(result.includes, []);
    assertRevealsNothingOutside(result, out);
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("a symlinked folder does not widen the source boundary, at any depth", async () => {
  const out = outside({ "nested/secret.md": SECRET });
  const root = source({ "a.md": "", "deep/b.md": "" });
  symlinkSync(out, join(root, "escape-dir"));
  try {
    const atRoot = await expand(root, "a.md", "top\n::include[escape-dir/secret.md]\nend\n");
    assertRefused(atRoot, "a.md", 2);
    assert.equal(atRoot.body, "top\nend\n");
    assertRevealsNothingOutside(atRoot, out);

    const deeper = await expand(root, "deep/b.md", "top\n::include[../escape-dir/nested/secret.md]\nend\n");
    assertRefused(deeper, "deep/b.md", 2);
    assertRevealsNothingOutside(deeper, out);

    // A target that does not exist outside is refused on the same ground: it could never be read from here.
    const absent = await expand(root, "a.md", "::include[escape-dir/absent.md]\n");
    assertRefused(absent, "a.md", 1);
    assert.deepEqual(absent.includes, []);
    assertRevealsNothingOutside(absent, out);
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("a nested include that escapes through a symlink is refused at the directive that names it", async () => {
  const out = outside({ "secret.md": SECRET });
  const root = source({ "mid.md": "Middle\n::include[escape.md]\nEnd\n" });
  symlinkSync(join(out, "secret.md"), join(root, "escape.md"));
  try {
    const result = await expand(root, "a.md", "Start\n::include[mid.md]\nFinish\n");
    assertRefused(result, "mid.md", 2);
    assert.equal(result.body, "Start\nMiddle\nEnd\nFinish\n");
    // The edge that stayed inside is a dependency; the refused one is not.
    assert.deepEqual(
      result.includes.map((i) => i.path),
      ["mid.md"],
    );
    assertRevealsNothingOutside(result, out);
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("an include whose symlink stays inside the source folder still works", async () => {
  const root = source({
    "a.md": "",
    "real/note.md": "Internal text.\n",
    "real/page.md": "Page.\n",
    "real/deep/two.md": "Deeper text.\n",
  });
  symlinkSync("real", join(root, "alias"));
  symlinkSync(join("real", "note.md"), join(root, "note-alias.md"));
  try {
    const throughDir = await expand(root, "a.md", "::include[alias/note.md]\n");
    assert.deepEqual(throughDir.diagnostics, []);
    assert.equal(throughDir.body, "Internal text.\n");
    // Dependency records keep the source-relative spelling, never the canonical path.
    assert.deepEqual(
      throughDir.includes.map((i) => ({ from: i.from, path: i.path, missing: i.missing })),
      [{ from: "a.md", path: "alias/note.md", missing: false }],
    );

    const throughFile = await expand(root, "a.md", "::include[note-alias.md]\n");
    assert.deepEqual(throughFile.diagnostics, []);
    assert.equal(throughFile.body, "Internal text.\n");

    const nested = await expand(root, "a.md", "::include[alias/deep/two.md]\n");
    assert.deepEqual(nested.diagnostics, []);
    assert.equal(nested.body, "Deeper text.\n");

    // A source folder that is itself a symlink canonicalizes both sides of the boundary.
    const reachedByLink = await expand(join(root, "alias"), "page.md", "top\n\n::include[note.md]\n");
    assert.deepEqual(reachedByLink.diagnostics, []);
    assert.equal(reachedByLink.body, "top\n\nInternal text.\n");
    assert.deepEqual(
      reachedByLink.includes.map((i) => ({ from: i.from, path: i.path, missing: i.missing })),
      [{ from: "page.md", path: "note.md", missing: false }],
    );
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("a symlink alias of a file on the include stack is a cycle, not a second read", async () => {
  const root = source({
    "a.md": "A\n::include[b.md]\n",
    "b.md": "B\n::include[a-alias.md]\n",
  });
  symlinkSync("a.md", join(root, "a-alias.md"));
  try {
    const result = await expand(root, "a.md", "A\n::include[b.md]\n");
    const cycles = result.diagnostics.filter((d) => d.id === "include.cycle");
    assert.equal(cycles.length, 1, JSON.stringify(result.diagnostics));
    assert.equal(result.diagnostics.length, 1);
    assert.match(cycles[0]!.message, /a\.md → b\.md → a-alias\.md/);
    // The alias was caught on the stack, so `a.md` was never expanded a second time.
    assert.equal(result.body, "A\nB\n");
    assert.deepEqual(
      result.includes.map((i) => i.path),
      ["b.md", "a-alias.md"],
    );
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("a page reached through an alias includes that alias back", async () => {
  const root = source({
    "real/a.md": "A\n::include[../a-alias.md]\n",
  });
  symlinkSync(join("real", "a.md"), join(root, "a-alias.md"));
  try {
    const result = await expand(root, "real/a.md", "A\n::include[../a-alias.md]\n");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.id, "include.cycle");
    assert.equal(result.body, "A\n");
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

test("an ordinary relative include, a missing file and the depth limit keep their behavior", async () => {
  const out = outside({ "secret.md": SECRET });
  const root = source({
    "guide/intro.md": "",
    "guide/snippets/one.md": "One.\n\n::include[../shared/two.md]\n",
    "guide/shared/two.md": "Two.\n",
    "chain/a.md": "::include[b.md]\n",
    "chain/b.md": "::include[c.md]\n",
    "chain/c.md": "deep\n",
  });
  symlinkSync(join(out, "secret.md"), join(root, "guide", "escape.md"));
  symlinkSync("snippets", join(root, "guide", "snip"));
  try {
    // The plain path still expands with no diagnostics.
    const plain = await expand(root, "guide/intro.md", "::include[snippets/one.md]\n");
    assert.deepEqual(plain.diagnostics, []);
    assert.equal(plain.body, "One.\n\nTwo.\n");

    // A missing target is still `include.missing`, with its dependency record.
    const missing = await expand(root, "guide/intro.md", "intro\n\n::include[nope.md]\nafter\n");
    assert.equal(missing.diagnostics.length, 1);
    assert.equal(missing.diagnostics[0]?.id, "include.missing");
    assert.equal(missing.diagnostics[0]?.pos?.file, "guide/intro.md");
    assert.equal(missing.diagnostics[0]?.pos?.line, 3);
    assert.equal(missing.body, "intro\n\nafter\n");
    assert.deepEqual(
      missing.includes.map((i) => ({ path: i.path, missing: i.missing })),
      [{ path: "guide/nope.md", missing: true }],
    );

    // A missing target behind an internal symlink dir is missing, not outside.
    const behindAlias = await expand(root, "guide/intro.md", "::include[snip/absent.md]\n");
    assert.equal(behindAlias.diagnostics[0]?.id, "include.missing");
    assert.equal(behindAlias.includes[0]?.path, "guide/snip/absent.md");
    assert.equal(behindAlias.includes[0]?.missing, true);

    // A dangling symlink (its target does not exist) is a missing file too.
    symlinkSync(join(out, "absent.md"), join(root, "guide", "dangling.md"));
    const dangling = await expand(root, "guide/intro.md", "::include[dangling.md]\n");
    assert.equal(dangling.diagnostics[0]?.id, "include.missing");
    assertRevealsNothingOutside(dangling, out);

    // The depth limit still reports at the nested directive with the source-relative path.
    const deep = await expand(root, "chain/a.md", "::include[b.md]\n", { maxDepth: 1 });
    assert.equal(deep.diagnostics.length, 1);
    assert.equal(deep.diagnostics[0]?.id, "include.too-deep");
    assert.equal(deep.diagnostics[0]?.pos?.file, "chain/b.md");
    assert.equal(deep.body, "");

    // A folder is still unreadable rather than outside.
    const folder = await expand(root, "guide/intro.md", "::include[snippets]\n");
    assert.equal(folder.diagnostics[0]?.id, "include.unreadable");

    // A lexical escape keeps its own diagnostic, and the outside file was never touched.
    const lexical = await expand(root, "guide/intro.md", `::include[../../${basenameOf(out)}/secret.md]\n`);
    assert.equal(lexical.diagnostics.length, 1);
    assert.equal(lexical.diagnostics[0]?.id, "include.outside-source");
    assert.deepEqual(lexical.includes, []);
    assert.equal(existsSync(join(out, "secret.md")), true);
  } finally {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

/** Last component of a path, without importing another helper for one use. */
function basenameOf(path: string): string {
  const parts = path.split(sep).filter((p) => p !== "");
  return parts[parts.length - 1]!;
}
