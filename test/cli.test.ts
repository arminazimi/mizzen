import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NAME, main, parseArgs, siblingThemeRoot, usage } from "../src/cli/index.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** Folders another test's build may be writing into the fixture; a build cache is never input. */
const TRANSIENT = new Set([".mizzen", ".tmp", "node_modules", ".git"]);

/** Copies the fixture into `parent` so the CLI's build cache cannot land inside the shared fixture. */
function copyFixture(parent: string): string {
  const root = join(parent, "docs-site");
  cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => TRANSIENT.has(part)),
  });
  return root;
}

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (m: string) => {
        logs.push(m);
      },
      error: (m: string) => {
        errors.push(m);
      },
    },
  };
}

test("parseArgs: help, build defaults, check format, and usage errors", () => {
  assert.deepEqual(parseArgs([]), { help: true });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["build"]), {
    options: { command: "build", root: ".", out: "dist" },
  });
  assert.deepEqual(parseArgs(["build", "site", "--out", "public", "--theme", "/t"]), {
    options: { command: "build", root: "site", out: "public", theme: "/t" },
  });
  assert.deepEqual(parseArgs(["check", "--format", "json"]), {
    options: { command: "check", root: ".", format: "json" },
  });
  assert.equal("error" in parseArgs(["nope"]), true);
  assert.equal("error" in parseArgs(["build", "--format", "text"]), true);
  assert.equal("error" in parseArgs(["check", "--out", "dist"]), true);
  assert.equal("error" in parseArgs(["check", "--format", "yaml"]), true);
});

test("usage documents the unchecked edit override", () => {
  assert.match(usage, /--allow-unchecked/);
});

test("build writes the site and exits 0 when there are no errors", async () => {
  const root = tree({
    "mizzen.yml":
      "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Hello\n",
  });
  const out = join(root, "_out");
  const { logs, errors, io } = capture();
  try {
    const code = await main(["build", root, "--out", out, "--theme", THEME], io);
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.ok(existsSync(join(out, "index.html")));
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /Hello/);
    // No diagnostics → nothing printed.
    assert.deepEqual(logs, []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("build exits 1 when the site has errors and still writes pages", async () => {
  const root = tree({
    "a.md": "---\nlayout: nope\n---\n# A\n",
  });
  const out = join(root, "_out");
  const { logs, io } = capture();
  try {
    const code = await main(["build", root, "--out", out, "--theme", THEME], io);
    assert.equal(code, 1);
    assert.ok(logs.some((line) => line.includes("render.unknown-layout")));
    assert.ok(existsSync(join(out, "a/index.html")));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("check prints text, json, and sarif and leaves no output folder behind", async () => {
  const root = tree({
    "mizzen.yml":
      "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "index.md": "# Hello\n",
  });
  try {
    const text = capture();
    assert.equal(await main(["check", root, "--theme", THEME], text.io), 0);
    assert.match(text.logs.join("\n"), /0 errors, 0 warnings/);

    const json = capture();
    assert.equal(await main(["check", root, "--theme", THEME, "--format", "json"], json.io), 0);
    const parsed = JSON.parse(json.logs.join("\n")) as { version: number; diagnostics: unknown[] };
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.diagnostics, []);

    const sarif = capture();
    assert.equal(await main(["check", root, "--theme", THEME, "--format", "sarif"], sarif.io), 0);
    const log = JSON.parse(sarif.logs.join("\n")) as {
      version: string;
      runs: { tool: { driver: { name: string } } }[];
    };
    assert.equal(log.version, "2.1.0");
    assert.equal(log.runs[0]?.tool.driver.name, NAME);

    assert.equal(existsSync(join(root, "dist")), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("usage errors exit 2 and print the help", async () => {
  const { logs, errors, io } = capture();
  assert.equal(await main(["wat"], io), 2);
  assert.equal(logs.length, 0);
  assert.ok(errors[0]?.includes("unknown command"));
  assert.ok(errors[0]?.includes(usage.split("\n")[0]!));
});

test("a packed CLI has no Lateen fallback", () => {
  // From `src/` the sibling checkout is a development convenience...
  assert.equal(
    siblingThemeRoot("file:///repo/src/cli/index.ts"),
    fileURLToPath(new URL("../../../lateen", "file:///repo/src/cli/index.ts")),
  );
  // ...but a packed `dist/cli/` resolves that path into `node_modules/@velella/lateen`, so it gets nothing.
  assert.equal(siblingThemeRoot("file:///app/node_modules/@velella/mizzen/dist/cli/index.js"), undefined);
});

test("every command usage names is dispatched", async () => {
  const commands = [
    ...new Set(
      usage
        .split("\n")
        .filter((line) => /^ {2}[a-z]/.test(line))
        .map((line) => line.trim().split(/\s+/)[0]!),
    ),
  ];
  assert.deepEqual(commands, ["build", "check", "dev", "doctor", "edit", "pack", "verify", "watch"]);
  for (const command of commands) {
    const { errors, io } = capture();
    const status = await main([command, "--help"], io);
    assert.equal(status, 0, `${command} --help: ${errors.join("")}`);
  }
});

test("the bin builds fixtures/docs-site with the sibling theme", () => {
  const parent = mkdtempSync(join(tmpdir(), "cli-bin-"));
  const out = join(parent, "site");
  try {
    const result = spawnSync(process.execPath, [BIN, "build", copyFixture(parent), "--out", out], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(join(out, "quickstart/index.html")));
  } finally {
    rmSync(parent, { recursive: true });
  }
});
