import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxAvailable, runShellExample } from "../src/pipeline/examples/run-shell.ts";

/** True when this host has an OS sandbox, so the tests that need one can skip instead of assuming it (like `hasGit`). */
const hasSandbox = sandboxAvailable();

/** A path, quoted for a POSIX shell. The paths here come from `mkdtemp`, never from user input. */
function quote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

test("a bash example runs with bash and its exit code is zero", async () => {
  const result = await runShellExample({ shell: "bash", code: 'echo "$0"' });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.trimEnd().endsWith("bash"), `stdout names bash: ${result.stdout}`);
  assert.equal(result.timedOut, false);
});

test("an sh example runs with sh", async () => {
  const result = await runShellExample({ shell: "sh", code: 'echo "$0"' });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.trimEnd().endsWith("/sh") || result.stdout.trim() === "sh", `stdout names sh: ${result.stdout}`);
});

test("stdout and stderr are captured separately and a non-zero exit is a result, not a throw", async () => {
  const result = await runShellExample({
    shell: "sh",
    code: "printf 'out\\n'; printf 'err\\n' >&2; exit 3",
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.timedOut, false);
});

test("a snippet that hangs is killed when the timeout fires", async () => {
  const result = await runShellExample({ shell: "sh", code: "sleep 5", timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3_000, `the process group was killed promptly (${result.durationMs}ms)`);
  assert.notEqual(result.exitCode, 0);
});

test("the environment is an allow-list, with HOME and TMPDIR inside the run folder", async () => {
  const before = process.env.SLIPWAY_TEST_SECRET;
  process.env.SLIPWAY_TEST_SECRET = "must-not-leak";
  try {
    const result = await runShellExample({
      shell: "sh",
      code: 'printf "%s|%s|%s|%s|%s\\n" "$SLIPWAY_TEST_SECRET" "$HOME" "$TMPDIR" "$NO_COLOR" "$EXTRA"',
      env: { EXTRA: "explicit" },
    });
    const [secret, home, temp, noColor, extra] = result.stdout.trimEnd().split("|");
    assert.equal(secret, "", "a host variable outside the allow-list is dropped");
    assert.notEqual(home, process.env.HOME, "HOME is not the real home");
    assert.ok(home?.startsWith(result.workdir), `HOME is inside the run folder: ${home}`);
    assert.ok(temp?.startsWith(result.workdir), `TMPDIR is inside the run folder: ${temp}`);
    assert.equal(noColor, "1");
    assert.equal(extra, "explicit", "the caller's env option is the explicit way in");
  } finally {
    if (before === undefined) delete process.env.SLIPWAY_TEST_SECRET;
    else process.env.SLIPWAY_TEST_SECRET = before;
  }
});

test("the temporary folder is removed afterwards", async () => {
  const result = await runShellExample({ shell: "sh", code: "pwd" });
  assert.equal(result.exitCode, 0);
  assert.ok(result.workdir.length > 0, "the result names the folder it used");
  assert.equal(existsSync(result.workdir), false, "the throwaway folder is gone");
});

test("a caller-given cwd is kept and the internal home and temp folders are cleaned up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-example-cwd-"));
  try {
    writeFileSync(join(dir, "note.txt"), "kept\n");
    const result = await runShellExample({ shell: "sh", code: "cat note.txt", cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "kept\n");
    assert.equal(existsSync(dir), true, "a folder the caller owns is not removed");
    assert.equal(existsSync(join(dir, ".mizzen-home")), false, "the internal home folder is removed");
    assert.equal(existsSync(join(dir, ".mizzen-tmp")), false, "the internal temp folder is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the result says honestly whether the run was sandboxed", async () => {
  const result = await runShellExample({ shell: "sh", code: "true" });
  assert.equal(result.sandboxed, hasSandbox);
});

test(
  "rm inside the example cannot reach outside the temporary directory",
  { skip: hasSandbox ? false : "no OS sandbox (sandbox-exec or bwrap) is available" },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "mizzen-example-outside-"));
    const outside = join(parent, "keep");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "still here\n");
    // The sandbox matches canonical paths, and macOS `tmpdir()` is a symlink target away from its real path.
    const target = realpathSync(outside);
    try {
      const result = await runShellExample({ shell: "sh", code: `rm -rf ${quote(target)}` });
      assert.equal(result.sandboxed, true, "the escape test only runs with a real sandbox");
      assert.equal(existsSync(join(target, "sentinel.txt")), true, "the file outside the run folder survived");
      assert.notEqual(result.exitCode, 0, "rm reported the refusal");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "without a sandbox the runner says so instead of claiming isolation",
  { skip: hasSandbox ? "this host has an OS sandbox" : false },
  async () => {
    const result = await runShellExample({ shell: "sh", code: "true" });
    assert.equal(result.sandboxed, false);
  },
);
