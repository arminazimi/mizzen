import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { usage } from "../src/cli/index.ts";
import type { Page } from "../src/contracts/index.ts";
import { build, type BuildResult } from "../src/pipeline/build.ts";
import { loadCodeConfig, runContentHooks } from "../src/plugins/hooks.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const README = readFileSync(join(PACKAGE, "README.md"), "utf8");
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** The TypeScript of a README example, found by the HTML comment above its fence. */
function snippet(name: string): string {
  const marker = `<!-- readme-example: ${name} -->`;
  const at = README.indexOf(marker);
  assert.notEqual(at, -1, `README.md has the ${name} example`);
  const open = README.indexOf("\n```ts\n", at);
  assert.notEqual(open, -1, `the ${name} example is a TypeScript fence`);
  const start = open + "\n```ts\n".length;
  const end = README.indexOf("\n```", start);
  assert.notEqual(end, -1, `the ${name} example is closed`);
  return README.slice(start, end);
}

let written = 0;

/** Writes an example beside this test, so its relative imports resolve as the README shows them. */
function writeExample(name: string, text: string): string {
  const file = join(HERE, `.readme-${name}-${process.pid}-${written++}.ts`);
  writeFileSync(file, text);
  return file;
}

function site(): string {
  return mkdtempSync(join(tmpdir(), "readme-site-"));
}

test("the CLI help in the README is the command's own help", () => {
  assert.ok(README.includes(usage), "the CLI section quotes the usage string exactly");
});

test("the README's programmatic build example runs", async () => {
  const root = site();
  const parent = mkdtempSync(join(tmpdir(), "readme-out-"));
  const out = join(parent, "dist");
  const file = writeExample("build", snippet("programmatic-build"));
  try {
    mkdirSync(join(root, "guide"), { recursive: true });
    writeFileSync(join(root, "mizzen.yml"), "title: Readme\n");
    writeFileSync(join(root, "guide", "install.md"), "---\nlayout: doc\n---\n# Install\n");
    const mod = (await import(pathToFileURL(file).href)) as {
      buildSite: (root: string, out: string, themeRoot: string) => Promise<BuildResult>;
    };
    const result = await mod.buildSite(root, out, THEME);
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    assert.ok(result.files.includes("guide/install/index.html"), result.files.join(", "));
  } finally {
    rmSync(file, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the README's custom output example runs", async () => {
  const root = site();
  const outputs = mkdtempSync(join(tmpdir(), "readme-outputs-"));
  const parent = mkdtempSync(join(tmpdir(), "readme-out-"));
  const out = join(parent, "dist");
  try {
    writeFileSync(join(root, "mizzen.yml"), "title: Readme\n");
    writeFileSync(join(outputs, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(outputs, "feeds.ts"), snippet("custom-output"));
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    assert.ok(result.files.includes("feed.txt"), result.files.join(", "));
    assert.equal(readFileSync(join(out, "feed.txt"), "utf8"), "hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputs, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the README's plugin example loads and runs", async () => {
  const root = site();
  try {
    writeFileSync(join(root, "mizzen.yml"), "title: Readme\n");
    writeFileSync(join(root, "mizzen.config.ts"), snippet("plugin"));
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.plugins.length, 1);

    const page: Page = {
      url: "/install/",
      source: { file: "install.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
      frontMatter: {},
      title: "Install",
      lang: "en",
      dir: "ltr",
      headings: [],
      html: "",
      markdown: "",
      kind: "doc",
    };
    const result = await runContentHooks(loaded.plugins, page);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.value.frontMatter.banner, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
