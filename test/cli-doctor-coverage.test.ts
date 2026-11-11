import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctor, doctorReport } from "../src/cli/doctor.ts";
import { coverageDiagnostics, DOCTOR_CHECKS, type DoctorReport } from "../src/cli/doctor-report.ts";
import { main } from "../src/cli/index.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-doctor-coverage-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A minimal theme whose one layout throws when the render stage calls it. */
function throwingTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-doctor-theme-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(root, "src", "index.ts"), 'export const theme = { name: "throwy", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts", "doc.ts"),
    'export default function layout(): string {\n  throw new Error("layout exploded");\n}\n',
  );
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

/** The state of every check in a report, keyed by check id. */
function states(report: DoctorReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((check) => [check.id, check.state]));
}

const VALID: Record<string, string> = {
  "mizzen.yml":
    "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "# Hello\n",
};

const DUPLICATE_URLS: Record<string, string> = {
  "a.md": "---\npermalink: /same/\n---\n# A\n",
  "b.md": "---\npermalink: /same/\n---\n# B\n",
};

/** A config that names a theme that cannot be resolved, so the CLI finds no theme root. */
const NO_THEME: Record<string, string> = {
  "mizzen.yml":
    "title: Demo\nurl: https://example.com\ntheme:\n  name: nowhere-to-be-found\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "# Hello\n",
};

test("a clean site accounts for all six checks and adds no coverage findings", async () => {
  const root = tree(VALID);
  try {
    const report = await doctorReport({ root, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(report.checks.map((check) => check.id), [...DOCTOR_CHECKS]);
    assert.deepEqual(states(report), {
      runtime: "passed",
      config: "passed",
      content: "passed",
      theme: "passed",
      render: "passed",
      output: "passed",
    });
    assert.deepEqual(report.diagnostics, [], "nothing is reported for a clean site");

    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 0);
    assert.deepEqual(JSON.parse(json.logs.join("\n")), { version: 1, diagnostics: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed content fails its own check without failing the later ones", async () => {
  const root = tree({ ...VALID, ...DUPLICATE_URLS });
  try {
    const report = await doctorReport({ root, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(states(report), {
      runtime: "passed",
      config: "passed",
      content: "failed",
      theme: "passed",
      render: "passed",
      output: "passed",
    });
    const ids = report.diagnostics.map((found) => found.id);
    assert.ok(ids.includes("page.duplicate-url"), "the content finding is reported");
    assert.equal(ids.includes("doctor.check-skipped"), false, "no check was skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime and config failures are attributed to their own checks", async () => {
  const configRoot = tree({ ...VALID, "mizzen.yml": `${VALID["mizzen.yml"]}not_a_key: true\n` });
  const runtimeRoot = tree(VALID);
  try {
    const configReport = await doctorReport({ root: configRoot, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(states(configReport), {
      runtime: "passed",
      config: "failed",
      content: "passed",
      theme: "passed",
      render: "passed",
      output: "passed",
    });

    const runtimeReport = await doctorReport({
      root: runtimeRoot,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: "22.11.0",
    });
    assert.deepEqual(states(runtimeReport), {
      runtime: "failed",
      config: "passed",
      content: "passed",
      theme: "passed",
      render: "passed",
      output: "passed",
    });
    assert.deepEqual(runtimeReport.diagnostics.map((found) => found.id), ["doctor.node-version"]);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("a missing theme skips three checks, keeps the content finding, and says so in JSON and SARIF", async () => {
  const root = tree({ ...NO_THEME, ...DUPLICATE_URLS });
  const before = readdirSync(root).sort();
  try {
    const report = await doctorReport({ root });
    assert.deepEqual(states(report), {
      runtime: "passed",
      config: "passed",
      content: "failed",
      theme: "skipped",
      render: "skipped",
      output: "skipped",
    });
    const skipped = report.diagnostics.filter((found) => found.id === "doctor.check-skipped");
    assert.equal(skipped.length, 3, "theme, render, and output each account for themselves");
    assert.deepEqual(skipped.map((found) => found.severity), ["info", "info", "info"], "a skip never fails a site");
    assert.equal(skipped.every((found) => found.help !== undefined), true, "every skip says what to provide");
    assert.ok(skipped.some((found) => /theme check was skipped: no theme root/.test(found.message)));

    const json = capture();
    assert.equal(await main(["doctor", root, "--format", "json"], json.io), 1);
    const machine = JSON.parse(json.logs.join("\n")) as {
      version: number;
      diagnostics: { id: string; severity: string }[];
    };
    assert.equal(machine.version, 1);
    assert.ok(machine.diagnostics.some((found) => found.id === "page.duplicate-url"), "the content finding survives");
    assert.equal(machine.diagnostics.filter((found) => found.id === "doctor.check-skipped").length, 3);
    assert.equal(
      machine.diagnostics.filter((found) => found.id === "doctor.check-skipped").every((found) => found.severity === "info"),
      true,
    );

    const sarif = capture();
    assert.equal(await main(["doctor", root, "--format", "sarif"], sarif.io), 1);
    const log = JSON.parse(sarif.logs.join("\n")) as {
      runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; level: string }[] }[];
    };
    const run = log.runs[0]!;
    assert.ok(run.tool.driver.rules.some((rule) => rule.id === "doctor.check-skipped"));
    assert.equal(
      run.results.filter((result) => result.ruleId === "doctor.check-skipped" && result.level === "note").length,
      3,
    );
    assert.deepEqual(readdirSync(root).sort(), before, "the site is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source still runs the theme check and skips only what depends on the source", async () => {
  const theme = mkdtempSync(join(tmpdir(), "cli-doctor-broken-theme-"));
  const root = tree({ "mizzen.yml": "title: Demo\nsource: docs\n", "index.md": "# Not in the source folder\n" });
  try {
    const report = await doctorReport({ root, themeRoot: theme });
    assert.deepEqual(states(report), {
      runtime: "passed",
      config: "passed",
      content: "skipped",
      theme: "failed",
      render: "skipped",
      output: "skipped",
    });
    const ids = report.diagnostics.map((found) => found.id);
    assert.ok(ids.includes("doctor.source-missing"));
    assert.ok(ids.includes("registry.missing-manifest"), "the theme check runs without the source");
    const content = report.checks.find((check) => check.id === "content");
    assert.equal(content?.state, "skipped");
    if (content?.state !== "skipped") throw new Error("expected a skipped content check");
    assert.match(content.reason, /"docs"/);

    assert.deepEqual(await doctorReport({ root, themeRoot: theme }), report, "coverage is deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
  }
});

test("a throwing layout keeps the content findings and marks the unverified stages skipped", async () => {
  const theme = throwingTheme();
  const root = tree({ ...VALID, ...DUPLICATE_URLS });
  try {
    const report = await doctorReport({ root, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(states(report), {
      runtime: "passed",
      config: "passed",
      content: "failed",
      theme: "passed",
      render: "skipped",
      output: "skipped",
    });
    const ids = report.diagnostics.map((found) => found.id);
    assert.ok(ids.includes("page.duplicate-url"), "the content finding survives the build failure");
    assert.ok(ids.includes("doctor.build-failed"));
    const skipped = report.diagnostics.filter((found) => found.id === "doctor.check-skipped");
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every((found) => /the build check could not finish/.test(found.message)));

    assert.deepEqual(await doctorReport({ root, themeRoot: theme, defaultLayout: "doc" }), report);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
  }
});

test("temporary folders are removed on success and failure, and the site is untouched", async () => {
  const theme = throwingTheme();
  const root = tree(VALID);
  const tmpRoot = mkdtempSync(join(tmpdir(), "cli-doctor-tmp-"));
  const before = readdirSync(root).sort();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  try {
    const clean = await doctor({ root, themeRoot: THEME, defaultLayout: "doc" });
    assert.equal(clean.some((found) => found.severity === "error"), false);
    assert.deepEqual(readdirSync(tmpRoot), [], "the clean run left no temporary folder");

    const broken = await doctor({ root, themeRoot: theme, defaultLayout: "doc" });
    assert.ok(broken.some((found) => found.id === "doctor.build-failed"));
    assert.deepEqual(readdirSync(tmpRoot), [], "the failed run left no temporary folder");

    assert.deepEqual(readdirSync(root).sort(), before, "the site is untouched");
    assert.equal(existsSync(join(root, "dist")), false, "no output folder appears");
    assert.equal(existsSync(join(root, ".mizzen")), false, "no cache appears");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
  }
});

test("skipped coverage is informational only and names its stable reason", () => {
  const diagnostics = coverageDiagnostics([
    { id: "runtime", state: "passed" },
    { id: "theme", state: "skipped", reason: "no theme root was found for this site" },
  ]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "doctor.check-skipped");
  assert.equal(diagnostics[0]?.severity, "info");
  assert.match(diagnostics[0]?.message ?? "", /theme check was skipped: no theme root was found for this site/);
  assert.equal(typeof diagnostics[0]?.help, "string");
});
