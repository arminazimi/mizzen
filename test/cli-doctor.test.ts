import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctor, MIN_NODE_MAJOR, runtimeDiagnostic } from "../src/cli/doctor.ts";
import { COMMANDS, main, NAME, parseArgs, usage } from "../src/cli/index.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-doctor-"));
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

const VALID: Record<string, string> = {
  "mizzen.yml":
    "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "# Hello\n",
};

test("parseArgs: doctor defaults, flags, and usage errors", () => {
  assert.deepEqual(parseArgs(["doctor"]), {
    options: { command: "doctor", root: ".", format: "text" },
  });
  assert.deepEqual(parseArgs(["doctor", "site", "--theme", "/t", "--format", "json"]), {
    options: { command: "doctor", root: "site", format: "json", theme: "/t" },
  });
  assert.equal("error" in parseArgs(["doctor", "--out", "dist"]), true);
  assert.equal("error" in parseArgs(["doctor", "--hash", "abc"]), true);
  assert.equal("error" in parseArgs(["doctor", "--format", "yaml"]), true);
  assert.match(usage, /doctor \[dir\]/);
  assert.ok(usage.includes("text, json, or sarif (check and doctor"), "the help names doctor for --format");
});

test("every registered command parses and is documented", () => {
  for (const command of COMMANDS) {
    assert.deepEqual(parseArgs([command, "--help"]), { help: true }, `\`${NAME} ${command}\` is registered`);
    assert.ok(usage.includes(`\n  ${command} `), `the help lists \`${NAME} ${command}\``);
  }
});

test("doctor exits 0 for a valid site, prints the count, and writes nothing", async () => {
  const root = tree(VALID);
  const before = readdirSync(root).sort();
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 0);
    assert.deepEqual(errors, []);
    assert.equal(logs.join("\n"), "0 errors, 0 warnings");
    assert.deepEqual(readdirSync(root).sort(), before, "the site folder is untouched");
    assert.equal(existsSync(join(root, "dist")), false, "no output folder appears");
    assert.equal(existsSync(join(root, ".mizzen")), false, "no cache appears");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor prints an empty machine-readable report for a valid site", async () => {
  const root = tree(VALID);
  try {
    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 0);
    assert.deepEqual(JSON.parse(json.logs.join("\n")), { version: 1, diagnostics: [] });

    const sarif = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "sarif"], sarif.io), 0);
    const log = JSON.parse(sarif.logs.join("\n")) as {
      version: string;
      runs: { tool: { driver: { name: string } }; results: unknown[] }[];
    };
    assert.equal(log.version, "2.1.0");
    assert.equal(log.runs[0]?.tool.driver.name, NAME);
    assert.deepEqual(log.runs[0]?.results, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid config exits 1 with an actionable finding at the config file", async () => {
  const root = tree({ ...VALID, "mizzen.yml": `${VALID["mizzen.yml"]}not_a_key: true\n` });
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    assert.deepEqual(errors, []);
    const text = logs.join("\n");
    assert.match(text, /mizzen\.yml:\d+:1\s+config\.unknown-key\s+Unknown key `not_a_key`\./);
    assert.ok(text.includes("help:"), "the finding says how to fix it");
    assert.match(text, /1 error, 0 warnings/);
    assert.equal(text.match(/config\.unknown-key/g)?.length, 1, "the config finding is reported once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid config is machine-readable and still leaves the site untouched", async () => {
  const root = tree({ ...VALID, "mizzen.yml": `${VALID["mizzen.yml"]}not_a_key: true\n` });
  const before = readdirSync(root).sort();
  try {
    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 1);
    const report = JSON.parse(json.logs.join("\n")) as {
      version: number;
      diagnostics: { id: string; severity: string; message: string; help?: string }[];
    };
    assert.equal(report.version, 1);
    const finding = report.diagnostics.find((d) => d.id === "config.unknown-key");
    assert.ok(finding !== undefined);
    assert.equal(finding.severity, "error");
    assert.match(finding.message, /not_a_key/);
    assert.equal(typeof finding.help, "string");
    assert.deepEqual(readdirSync(root).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content errors are reported with their source positions", async () => {
  const root = tree({
    ...VALID,
    "a.md": "---\npermalink: /same/\n---\n# A\n",
    "b.md": "---\npermalink: /same/\n---\n# B\n",
  });
  const { logs, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    const text = logs.join("\n");
    assert.ok(text.includes("page.duplicate-url"), "the duplicate URL is named");
    assert.match(text, /b\.md:\d+:\d+/, "the finding points at a source file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source folder is one actionable finding, not a crash", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\nsource: docs\n", "index.md": "# Not in the source folder\n" });
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    assert.deepEqual(errors, []);
    const text = logs.join("\n");
    assert.ok(text.includes("doctor.source-missing"));
    assert.ok(text.includes('"docs"'));
    assert.ok(text.includes("help:"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a theme, doctor names it and still checks the content", async () => {
  const root = tree({
    ...VALID,
    "a.md": "---\npermalink: /same/\n---\n# A\n",
    "b.md": "---\npermalink: /same/\n---\n# B\n",
  });
  try {
    const diagnostics = await doctor({ root });
    const ids = diagnostics.map((d) => d.id);
    assert.ok(ids.includes("doctor.missing-theme"));
    assert.ok(ids.includes("page.duplicate-url"), "content is checked without a theme");
    assert.equal(diagnostics.every((d) => d.help !== undefined), true, "every finding is actionable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime check fails only below the engine's oldest Node", () => {
  assert.equal(runtimeDiagnostic(`${MIN_NODE_MAJOR}.0.0`), undefined);
  assert.equal(runtimeDiagnostic("27.1.0"), undefined);
  const old = runtimeDiagnostic("22.11.0");
  assert.equal(old?.id, "doctor.node-version");
  assert.equal(old?.severity, "error");
  assert.match(old?.message ?? "", /22\.11\.0/);
  assert.match(old?.help ?? "", new RegExp(`Node\\.js ${MIN_NODE_MAJOR}`));
});

test("doctor reports the runtime check through the same diagnostics", async () => {
  const root = tree(VALID);
  try {
    const diagnostics = await doctor({ root, themeRoot: THEME, defaultLayout: "doc", nodeVersion: "22.11.0" });
    assert.deepEqual(diagnostics.map((d) => d.id), ["doctor.node-version"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
