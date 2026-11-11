import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_OUTPUT_BYTES, runNodeExample } from "../src/pipeline/examples/run-node.ts";
import { deniedCommand, sandboxAvailable } from "../src/pipeline/examples/run-shell.ts";

/** True when this host has an OS sandbox, so the tests that need one can skip instead of assuming it (like `hasGit`). */
const hasSandbox = sandboxAvailable();

test("a js example is an ES module and its stdout and exit code are captured", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: 'import { basename } from "node:path";\nconsole.log(`hello ${basename("/a/b.js")}`);\n',
  });
  assert.deepEqual(
    { ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut },
    { ok: true, exitCode: 0, stdout: "hello b.js\n", stderr: "", timedOut: false },
  );
  assert.ok(result.durationMs >= 0);
});

test("a ts example runs through Node's type stripping", async () => {
  const result = await runNodeExample({
    lang: "ts",
    code: 'const answer: number = 40 + 2;\nconsole.log(answer satisfies number);\n',
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "42\n");
});

test("an mjs example is an ES module", async () => {
  const result = await runNodeExample({
    lang: "mjs",
    code: 'import { basename } from "node:path";\nconsole.log(basename("/a/b.mjs"));\n',
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "b.mjs\n");
});

test("a non-zero exit is a result, not an exception", async () => {
  const result = await runNodeExample({ lang: "js", code: "process.exit(3);\n" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("stderr is captured separately from stdout", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: 'console.log("out");\nconsole.error("boom");\n',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "boom\n");
});

test("inherited Node coverage stays inside the example folder", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mizzen-node-coverage-"));
  const coverage = join(parent, "outside");
  const previous = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = coverage;
  try {
    const result = await runNodeExample({ lang: "js", code: "console.log(process.env.NODE_V8_COVERAGE);\n" });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.stderr, "");
    const seen = result.stdout.trim();
    assert.notEqual(seen, coverage);
    assert.equal(existsSync(coverage), false, "no coverage is written outside the run folder");
    assert.equal(existsSync(seen), false, "the run folder and its coverage are removed");
  } finally {
    if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a timeout kills the example and reports a timeout instead of hanging", async () => {
  const startedAt = Date.now();
  const result = await runNodeExample({
    lang: "js",
    code: "setInterval(() => {}, 1000);\nconsole.log(\"started\");\n",
    // Small on purpose: `timedOut` proves the child was alive when the timer fired, so no output has to arrive first.
    timeoutMs: 1_500,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.ok(elapsed < 5_000, `the run took ${String(elapsed)} ms, so the timeout did not kill it`);
});

test("the environment is scrubbed to PATH, HOME, TMPDIR, LANG, and NO_COLOR", async () => {
  process.env.MIZZEN_SCRUB_PROBE = "leaked";
  try {
    const result = await runNodeExample({
      lang: "js",
      env: { MIZZEN_EXTRA: "kept" },
      code: [
        "console.log(JSON.stringify({",
        "  cwd: process.cwd(),",
        '  probe: process.env.MIZZEN_SCRUB_PROBE ?? null,',
        '  extra: process.env.MIZZEN_EXTRA ?? null,',
        '  home: process.env.HOME ?? null,',
        '  tmpdir: process.env.TMPDIR ?? null,',
        '  lang: process.env.LANG ?? null,',
        '  noColor: process.env.NO_COLOR ?? null,',
        '  hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,',
        "}));",
        "",
      ].join("\n"),
    });
    assert.equal(result.ok, true, result.stderr);
    const seen = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(seen.probe, null, "a variable of the engine's environment is not visible");
    assert.equal(seen.extra, "kept", "the caller's extra variable is");
    assert.equal(seen.home, `${String(seen.cwd)}/home`);
    assert.equal(seen.tmpdir, `${String(seen.cwd)}/tmp`);
    assert.equal(seen.lang, "C.UTF-8");
    assert.equal(seen.noColor, "1");
    assert.equal(seen.hasPath, true);
  } finally {
    delete process.env.MIZZEN_SCRUB_PROBE;
  }
});

test("writes land in the temp folder and the temp folder is removed afterwards", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: [
      'import { existsSync, writeFileSync } from "node:fs";',
      'writeFileSync("made.txt", "hi");',
      'console.log(JSON.stringify({ cwd: process.cwd(), made: existsSync("made.txt") }));',
      "",
    ].join("\n"),
  });
  assert.equal(result.ok, true, result.stderr);
  const seen = JSON.parse(result.stdout) as { readonly cwd: string; readonly made: boolean };
  assert.equal(seen.made, true, "a relative write goes to the working directory");
  assert.equal(existsSync(seen.cwd), false, "the working directory is a temp folder the runner removed");
});

test("a caller's mistake is rejected before anything runs", async () => {
  await assert.rejects(() => runNodeExample({ lang: "js", code: "", timeoutMs: 0 }), RangeError);
  await assert.rejects(
    () => runNodeExample({ lang: "rb" as unknown as "js", code: "" }),
    TypeError,
  );
});

test("the result says honestly whether the run was sandboxed", async () => {
  const result = await runNodeExample({ lang: "js", code: 'console.log("hi");\n' });
  assert.equal(result.sandboxed, hasSandbox);
});

test("a denied word in a string literal or comment is not a command invocation", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: '// sudo rm -rf /\nconsole.log("sudo");\n',
  });
  assert.equal(result.rejected, false);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "sudo\n");
});

test("the denied-command guard reads only the command argument of spawn calls", () => {
  for (const code of [
    'execSync("sudo true")',
    'exec("sudo true")',
    'execFile("sudo", [])',
    'execFileSync("sudo", [])',
    'spawn("sudo", [])',
    'spawnSync("sudo", [])',
    'execSync("echo ok && sudo true")',
    'execSync("echo ok"); execSync("sudo true")',
    "execSync(`sudo true`)",
  ]) {
    assert.notEqual(deniedCommand(code, "node"), undefined, `rejects ${JSON.stringify(code)}`);
  }
  for (const code of [
    'console.log("sudo")',
    'const word = "sudo";',
    '// execSync("sudo true")',
    '/* spawn("sudo", []) */',
    '/* sudo',
    'spawn("echo", ["sudo"])',
    'execSync("echo sudo")',
    'fork("sudo-worker.js")',
    'const s = "sudo',
  ]) {
    assert.equal(deniedCommand(code, "node"), undefined, `allows ${JSON.stringify(code)}`);
  }
});

test("a Node example that invokes a denied command is refused before anything runs", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mizzen-node-denied-"));
  try {
    const result = await runNodeExample({
      lang: "js",
      cwd: parent,
      code: 'import { execSync } from "node:child_process";\nexecSync("sudo -n true");\n',
    });
    assert.equal(result.rejected, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.sandboxed, false);
    assert.match(result.stderr, /denied command "sudo"/);
    assert.deepEqual(readdirSync(parent), [], "no temp folder is created for a refused example");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a runaway example is cut off at the output cap and killed", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: 'setInterval(() => { for (let i = 0; i < 64; i++) console.log("x".repeat(1024)); }, 1);\n',
    timeoutMs: 10_000,
  });
  assert.equal(result.outputLimited, true);
  assert.equal(result.timedOut, false, "the output limit, not the timeout, ended the run");
  assert.equal(result.ok, false);
  assert.ok(result.stdout.endsWith("[output truncated]\n"), "the cut is marked");
  const kept = Buffer.byteLength(result.stdout) - Buffer.byteLength("\n[output truncated]\n");
  assert.equal(kept, MAX_OUTPUT_BYTES, "exactly the budget is kept");
});

test("a timeout kills the whole process group, including a spawned command", async () => {
  const result = await runNodeExample({
    lang: "js",
    code: 'import { spawn } from "node:child_process";\nspawn("sleep", ["30"], { stdio: "inherit" });\nsetInterval(() => {}, 1000);\n',
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
  // The spawned sleep holds the stdout pipe, so a kill of only the example would keep `close` waiting for it.
  assert.ok(result.durationMs < 5_000, `the group was killed promptly (${result.durationMs}ms)`);
});

test(
  "a Node example cannot write outside its temp folder when an OS sandbox is available",
  { skip: hasSandbox ? false : "no OS sandbox (sandbox-exec or bwrap) is available" },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "mizzen-node-outside-"));
    // The sandbox matches canonical paths, and macOS `tmpdir()` is a symlink target away from its real path.
    const target = join(realpathSync(parent), "escaped.txt");
    try {
      const result = await runNodeExample({
        lang: "js",
        env: { MIZZEN_TARGET: target },
        code: 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MIZZEN_TARGET, "escaped");\n',
      });
      assert.equal(result.sandboxed, true, "the escape test only runs with a real sandbox");
      assert.equal(result.ok, false, "the write was refused");
      assert.equal(existsSync(target), false, "no file was created outside the run folder");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
