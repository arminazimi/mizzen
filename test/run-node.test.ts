import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { runNodeExample } from "../src/pipeline/examples/run-node.ts";

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

test("a timeout kills the example and reports a timeout instead of hanging", async () => {
  const startedAt = Date.now();
  const result = await runNodeExample({
    lang: "js",
    code: "setInterval(() => {}, 1000);\nconsole.log(\"started\");\n",
    // Generous enough that a loaded machine still starts the child and prints before the timer fires.
    timeoutMs: 1_500,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "started\n");
  assert.ok(elapsed < 5_000, `the run took ${String(elapsed)} ms, so the timeout did not kill it`);
});

test("the environment is scrubbed to PATH, HOME, TMPDIR, LANG, and NO_COLOR", async () => {
  process.env.SLIPWAY_SCRUB_PROBE = "leaked";
  try {
    const result = await runNodeExample({
      lang: "js",
      env: { SLIPWAY_EXTRA: "kept" },
      code: [
        "console.log(JSON.stringify({",
        "  cwd: process.cwd(),",
        '  probe: process.env.SLIPWAY_SCRUB_PROBE ?? null,',
        '  extra: process.env.SLIPWAY_EXTRA ?? null,',
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
    delete process.env.SLIPWAY_SCRUB_PROBE;
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
