import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/contracts/index.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** Global the test outputs write to, so a test can see the order they ran in. */
type Log = { outputOrder?: string[] };

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary outputs folder: `package.json` marks it as an ES module so its `.ts` files import. Not copied: the outputs are not site files. */
function outputsTree(files: Record<string, string>): string {
  return tree({ ...files, "package.json": JSON.stringify({ type: "module", name: "temp-outputs" }) });
}

/** A temporary folder for the output; its parent is removed by the test. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "pipeline-out-"));
  return { parent, out: join(parent, "site") };
}

/** Every file under `dir` as path → text, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

function errors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

/** An output file for the outputs folder: writes `<name>.txt` and records its run order. */
function outputSource(name: string): string {
  return `export const ${name} = {
  name: "${name}",
  run() {
    const log = globalThis;
    (log.outputOrder ??= []).push("${name}");
    return Promise.resolve([{ path: "${name}.txt", contents: "${name}\\n" }]);
  },
};
`;
}

test("a site builds to one folder: pages in index.html files, assets copied, and the listed files are those written", async () => {
  const root = tree({
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n",
    "logo.txt": "logo\n",
  });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errors(result.diagnostics), []);
    assert.deepEqual([...snapshot(out).keys()].sort(), result.files, "the listed files are exactly the files written");
    assert.ok(result.files.includes("guide/install/index.html"));
    assert.ok(result.files.includes("logo.txt"));
    assert.equal(result.out, out);
    const page = readFileSync(join(out, "guide/install/index.html"), "utf8");
    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /Install/);
    assert.equal(readFileSync(join(out, "logo.txt"), "utf8"), "logo\n");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("two builds of one site write the same files with the same bytes", async () => {
  const root = tree({
    "a.md": "---\ntitle: A\n---\n# A\n",
    "b/c.md": "---\ntitle: C\n---\n# C\n",
    "img/x.txt": "x\n",
  });
  const first = scratch();
  const second = scratch();
  try {
    const one = await build({ root, out: first.out, themeRoot: THEME, defaultLayout: "doc" });
    const two = await build({ root, out: second.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(one.files, two.files);
    assert.deepEqual(snapshot(first.out), snapshot(second.out));
  } finally {
    rmSync(root, { recursive: true });
    rmSync(first.parent, { recursive: true });
    rmSync(second.parent, { recursive: true });
  }
});

test("outputs run in file-name order and a new output file needs no other edit", async () => {
  const root = tree({ "logo.txt": "logo\n" });
  const outputs = outputsTree({
    "zeta.ts": outputSource("zeta"),
    "alpha.ts": outputSource("alpha"),
    "helper.ts": "export function helper() { return 1; }\n",
    "README.md": "# Outputs\n",
  });
  const { parent, out } = scratch();
  const log = globalThis as Log;
  delete log.outputOrder;
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(errors(result.diagnostics), []);
    assert.deepEqual(log.outputOrder, ["alpha", "zeta"]);
    assert.deepEqual(result.files, ["alpha.txt", "logo.txt", "zeta.txt"]);
    assert.equal(readFileSync(join(out, "zeta.txt"), "utf8"), "zeta\n");
  } finally {
    delete log.outputOrder;
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("an output switched off in the config does not run and writes nothing", async () => {
  const root = tree({ "mizzen.yml": "outputs:\n  alpha: false\n", "logo.txt": "logo\n" });
  const outputs = outputsTree({ "alpha.ts": outputSource("alpha"), "zeta.ts": outputSource("zeta") });
  const { parent, out } = scratch();
  const log = globalThis as Log;
  delete log.outputOrder;
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(log.outputOrder, ["zeta"]);
    assert.equal(existsSync(join(out, "alpha.txt")), false);
    assert.ok(result.files.includes("zeta.txt"));
  } finally {
    delete log.outputOrder;
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("a failing output leaves the previous site in place and no staging folder behind", async () => {
  const root = tree({ "a.md": "---\ntitle: A\n---\n# A\n" });
  const outputs = outputsTree({
    "boom.ts": 'export const boom = { name: "boom", run() { throw new Error("boom"); } };\n',
  });
  const { parent, out } = scratch();
  mkdirSync(out);
  writeFileSync(join(out, "old.txt"), "old\n");
  try {
    await assert.rejects(build({ root, out, themeRoot: THEME, defaultLayout: "doc", outputsDir: outputs }), /boom/);
    assert.equal(readFileSync(join(out, "old.txt"), "utf8"), "old\n");
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith(".")), []);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("a finished build replaces the old site as a whole", async () => {
  const root = tree({ "logo.txt": "logo\n" });
  const { parent, out } = scratch();
  mkdirSync(out);
  writeFileSync(join(out, "stale.html"), "stale\n");
  try {
    await build({ root, out, themeRoot: THEME });
    assert.equal(existsSync(join(out, "stale.html")), false);
    assert.equal(readFileSync(join(out, "logo.txt"), "utf8"), "logo\n");
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith(".")), []);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("two outputs that write one path: the first wins and an error names both", async () => {
  const root = tree({ "logo.txt": "logo\n" });
  const outputs = outputsTree({
    "a.ts": 'export const a = { name: "a", run() { return Promise.resolve([{ path: "same.txt", contents: "A" }]); } };\n',
    "b.ts": 'export const b = { name: "b", run() { return Promise.resolve([{ path: "same.txt", contents: "B" }]); } };\n',
  });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    const dup = result.diagnostics.filter((d) => d.id === "output.duplicate-path");
    assert.equal(dup.length, 1);
    assert.equal(dup[0]?.severity, "error");
    assert.match(dup[0]?.message ?? "", /"a".*"b"/);
    assert.equal(readFileSync(join(out, "same.txt"), "utf8"), "A");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("an output path outside the output folder is an error and is not written", async () => {
  const root = tree({ "logo.txt": "logo\n" });
  const outputs = outputsTree({
    "escape.ts": 'export const escape = { name: "escape", run() { return Promise.resolve([{ path: "../escape.txt", contents: "x" }]); } };\n',
  });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(
      result.diagnostics.filter((d) => d.id === "output.bad-path").map((d) => d.severity),
      ["error"],
    );
    assert.equal(existsSync(join(parent, "escape.txt")), false);
    assert.equal(existsSync(join(out, "escape.txt")), false);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("an output whose name differs from its file name is an error and does not run", async () => {
  const root = tree({ "logo.txt": "logo\n" });
  const outputs = outputsTree({ "c.ts": 'export const c = { name: "other", run() { return Promise.resolve([{ path: "c.txt", contents: "c" }]); } };\n' });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(
      result.diagnostics.filter((d) => d.id === "output.name-mismatch").map((d) => d.severity),
      ["error"],
    );
    assert.equal(existsSync(join(out, "c.txt")), false);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("a site file wins over an output file at the same path, with no diagnostic", async () => {
  const root = tree({ "robots.txt": "site\n" });
  const outputs = outputsTree({
    "robots.ts": 'export const robots = { name: "robots", run() { return Promise.resolve([{ path: "robots.txt", contents: "generated\\n" }]); } };\n',
  });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.files, ["robots.txt"]);
    assert.equal(readFileSync(join(out, "robots.txt"), "utf8"), "site\n");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outputs, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("a page with no layout, or an unknown one, is an error that names the page", async () => {
  const root = tree({ "a.md": "# A\n", "b.md": "---\nlayout: nope\n---\n# B\n" });
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME });
    const ids = errors(result.diagnostics).map((d) => d.id).sort();
    assert.deepEqual(ids, ["render.no-layout", "render.unknown-layout"]);
    assert.match(errors(result.diagnostics).find((d) => d.id === "render.no-layout")?.message ?? "", /\/a\//);
    assert.match(errors(result.diagnostics).find((d) => d.id === "render.unknown-layout")?.message ?? "", /"nope"/);
    assert.ok(existsSync(join(out, "a/index.html")), "the page is still written so the build reports, not crashes");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("an output folder inside the source folder is refused unless its name starts with _ or .", async () => {
  const root = tree({ "a.md": "---\ntitle: A\n---\n# A\n" });
  try {
    await assert.rejects(build({ root, out: root, themeRoot: THEME }), TypeError);
    await assert.rejects(build({ root, out: join(root, "site"), themeRoot: THEME }), /inside the source folder/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a _site folder inside the source is not picked up by the next build", async () => {
  const root = tree({ "guide/install.md": "---\ntitle: Install\n---\n# Install\n" });
  const out = join(root, "_site");
  try {
    const first = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    const second = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.ok(first.files.includes("guide/install/index.html"));
    assert.deepEqual(second.files, first.files, "the second build does not pick up the first build's output");
    assert.deepEqual(errors(second.diagnostics), []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the pipeline builds fixtures/docs-site with the theme: no errors, app pages byte-identical", async () => {
  const { parent, out } = scratch();
  try {
    const result = await build({ root: FIXTURE, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errors(result.diagnostics), []);
    assert.ok(result.files.includes("quickstart/index.html"));
    assert.ok(result.files.includes("404.html"));
    assert.equal(readFileSync(join(out, "llms.txt"), "utf8"), readFileSync(join(FIXTURE, "llms.txt"), "utf8"), "the site's own llms.txt wins");
    assert.deepEqual(readFileSync(join(out, "dashboard/index.html")), readFileSync(join(FIXTURE, "dashboard/index.html")));
  } finally {
    rmSync(parent, { recursive: true });
  }
});
