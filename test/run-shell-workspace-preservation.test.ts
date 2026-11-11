/**
 * Issue #100: shell example cleanup must never destroy caller-owned workspace folders.
 *
 * With a caller-supplied `cwd`, the runner used to remove `.mizzen-home` and `.mizzen-tmp` recursively no matter who
 * created them, deleting unrelated caller content. These tests pin the non-destructive contract for every outcome —
 * success, non-zero exit, refusal, and timeout — while keeping HOME/TMPDIR isolation, cleanup of a runner-created
 * temporary workspace, and the meaning of every result field.
 *
 * Every destructive path here lives inside a `mkdtemp` fixture this test creates; no real user path is ever used.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runShellExample } from "../src/pipeline/examples/run-shell.ts";

const HOME_KEPT = "home sentinel, owned by the caller\n";
const TMP_KEPT = "tmp sentinel, owned by the caller\n";
const NOTE = "note.txt, owned by the caller\n";

/** A caller workspace that already contains `.mizzen-home` and `.mizzen-tmp` with content inside. */
function makeCallerWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-100-caller-"));
  mkdirSync(join(dir, ".mizzen-home"), { recursive: true });
  writeFileSync(join(dir, ".mizzen-home", "keep.txt"), HOME_KEPT);
  mkdirSync(join(dir, ".mizzen-tmp"), { recursive: true });
  writeFileSync(join(dir, ".mizzen-tmp", "keep.txt"), TMP_KEPT);
  writeFileSync(join(dir, "note.txt"), NOTE);
  return dir;
}

function assertCallerContentSurvives(dir: string, label: string): void {
  assert.equal(existsSync(dir), true, `${label}: the caller workspace itself survives`);
  assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), NOTE, `${label}: note.txt survives`);
  assert.equal(
    readFileSync(join(dir, ".mizzen-home", "keep.txt"), "utf8"),
    HOME_KEPT,
    `${label}: pre-existing .mizzen-home content survives`,
  );
  assert.equal(
    readFileSync(join(dir, ".mizzen-tmp", "keep.txt"), "utf8"),
    TMP_KEPT,
    `${label}: pre-existing .mizzen-tmp content survives`,
  );
}

/** Nothing the run created may survive in the caller's workspace; only its own three entries remain. */
function assertNoRunLeftovers(dir: string, label: string): void {
  assert.deepEqual(
    [...readdirSync(dir)].sort(),
    [".mizzen-home", ".mizzen-tmp", "note.txt"],
    `${label}: only the caller's own entries remain, run-owned folders are cleaned`,
  );
}

test("#100 a successful run with a caller cwd keeps pre-existing .mizzen-home and .mizzen-tmp", async () => {
  const dir = makeCallerWorkspace();
  try {
    const result = await runShellExample({ shell: "sh", code: "cat note.txt", cwd: dir });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, NOTE);
    assert.equal(result.rejected, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputLimited, false);
    assertCallerContentSurvives(dir, "successful run");
    assertNoRunLeftovers(dir, "successful run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#100 a non-zero exit keeps pre-existing .mizzen-home and .mizzen-tmp", async () => {
  const dir = makeCallerWorkspace();
  try {
    const result = await runShellExample({ shell: "sh", code: "printf 'err' >&2; exit 7", cwd: dir });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "err");
    assert.equal(result.timedOut, false);
    assertCallerContentSurvives(dir, "failing run");
    assertNoRunLeftovers(dir, "failing run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#100 a refused snippet keeps pre-existing .mizzen-home and .mizzen-tmp", async () => {
  const dir = makeCallerWorkspace();
  try {
    const result = await runShellExample({ shell: "sh", code: "sudo rm -rf /", cwd: dir });
    assert.equal(result.rejected, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.workdir, dir, "a refused run still names the caller's folder");
    assertCallerContentSurvives(dir, "refused run");
    assertNoRunLeftovers(dir, "refused run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#100 a timed-out run keeps pre-existing .mizzen-home and .mizzen-tmp", async () => {
  const dir = makeCallerWorkspace();
  try {
    // `sleep 30` cannot finish before the 300 ms timeout on any load, so the kill is a deterministic signal.
    const result = await runShellExample({ shell: "sh", code: "sleep 30", cwd: dir, timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assertCallerContentSurvives(dir, "timed-out run");
    assertNoRunLeftovers(dir, "timed-out run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#100 a workspace created by the runner is still removed completely", async () => {
  const result = await runShellExample({ shell: "sh", code: "pwd" });
  assert.equal(result.exitCode, 0);
  assert.ok(result.workdir.length > 0, "the result names the throwaway folder it used");
  assert.equal(existsSync(result.workdir), false, "the throwaway folder, run-owned folders inside it included, is gone");
});

test("#100 HOME and TMPDIR stay isolated, writable, and off the caller's pre-existing folders", async () => {
  const dir = makeCallerWorkspace();
  try {
    const result = await runShellExample({
      shell: "sh",
      code: 'printf "%s|%s\\n" "$HOME" "$TMPDIR"; echo fresh > "$HOME/written.txt" && echo new > "$TMPDIR/written.txt" && echo ok',
      cwd: dir,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.equal(lines[1], "ok", "both writes into HOME and TMPDIR succeeded during the run");
    const [home, temp] = lines[0]!.split("|");
    assert.ok(home!.startsWith(dir + "/"), `HOME stays inside the caller workspace: ${home}`);
    assert.ok(temp!.startsWith(dir + "/"), `TMPDIR stays inside the caller workspace: ${temp}`);
    assert.notEqual(home, join(dir, ".mizzen-home"), "HOME is a run-owned folder, not the caller's pre-existing one");
    assert.notEqual(temp, join(dir, ".mizzen-tmp"), "TMPDIR is a run-owned folder, not the caller's pre-existing one");
    // The run-owned folders are cleaned after the snippet wrote into them; the caller's pre-existing folders must
    // hold only their own content.
    assertCallerContentSurvives(dir, "isolated HOME/TMPDIR run");
    assert.equal(existsSync(join(dir, ".mizzen-home", "written.txt")), false, "nothing was written into the caller's .mizzen-home");
    assert.equal(existsSync(join(dir, ".mizzen-tmp", "written.txt")), false, "nothing was written into the caller's .mizzen-tmp");
    assertNoRunLeftovers(dir, "isolated HOME/TMPDIR run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
