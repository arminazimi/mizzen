import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const CI = readFileSync(join(PACKAGE, ".github", "workflows", "ci.yml"), "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
  readonly engines?: { readonly node?: string };
  readonly scripts?: Readonly<Record<string, string>>;
};

/** The human documentation: the README, the contributor guide, and the site's pages. */
const DOCUMENTS: readonly (readonly [string, string])[] = [
  ["README.md", README],
  ["CONTRIBUTING.md", readFileSync(join(PACKAGE, "CONTRIBUTING.md"), "utf8")],
  ...readdirSync(join(PACKAGE, "site"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => [`site/${name}`, readFileSync(join(PACKAGE, "site", name), "utf8")] as const),
];

/** The text of a documented file, for a test about one page. */
function document(file: string): string {
  const found = DOCUMENTS.find(([name]) => name === file);
  assert.ok(found !== undefined, `${file} is one of the documents`);
  return found[1];
}

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

test("the documents name test files that exist", () => {
  for (const [file, text] of DOCUMENTS) {
    for (const match of text.matchAll(/test\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
      assert.ok(existsSync(join(PACKAGE, match[0])), `${file} names ${match[0]}, which does not exist`);
    }
  }
});

test("the documents and the CI workflow name scripts that exist", () => {
  for (const [file, text] of [...DOCUMENTS, [".github/workflows/ci.yml", CI] as const]) {
    for (const match of text.matchAll(/scripts\/[A-Za-z0-9_./-]+/g)) {
      assert.ok(existsSync(join(PACKAGE, match[0])), `${file} names ${match[0]}, which does not exist`);
    }
  }
});

test("the documents run npm scripts that exist", () => {
  const scripts = PACKAGE_JSON.scripts ?? {};
  for (const [file, text] of DOCUMENTS) {
    for (const match of text.matchAll(/npm run ([\w:-]+)/g)) {
      const name = match[1]!;
      assert.notEqual(scripts[name], undefined, `${file} runs npm run ${name}, which package.json does not define`);
    }
    if (/\bnpm test\b/.test(text)) {
      assert.notEqual(scripts.test, undefined, `${file} runs npm test, which package.json does not define`);
    }
  }
});

test("the documents name CLI commands and entry points that exist", () => {
  const patterns = [
    /^\| `mizzen ([a-z]+(?: [a-z]+)?)/gm,
    /\bnpx mizzen ([a-z]+)/g,
    /\bnode bin\/mizzen\.ts ([a-z]+)/g,
  ];
  for (const [file, text] of DOCUMENTS) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const command = match[1]!;
        assert.ok(usage.includes(`\n  ${command} `), `${file} documents mizzen ${command}, which the help does not list`);
      }
    }
    for (const match of text.matchAll(/bin\/mizzen\.(?:ts|js)/g)) {
      assert.ok(existsSync(join(PACKAGE, match[0])), `${file} names ${match[0]}, which does not exist`);
    }
  }
});

test("the documents list every output the pipeline runs", () => {
  const dir = join(PACKAGE, "src", "outputs");
  const outputs = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /export const \w+: Output = \{/.test(readFileSync(join(dir, name), "utf8")))
    .map((name) => name.slice(0, -".ts".length));
  assert.ok(outputs.length > 0, "the outputs folder holds outputs");
  for (const name of outputs) {
    for (const file of ["README.md", "site/outputs.md"]) {
      assert.ok(document(file).includes(`| \`${name}\` |`), `${file} does not document the ${name} output`);
    }
  }
});

test("CI installs from the lockfile on the declared Node major", () => {
  const minimum = Number(/(\d+)/.exec(PACKAGE_JSON.engines?.node ?? "")?.[1]);
  assert.ok(minimum > 0, "package.json declares an engines.node major");
  assert.ok(existsSync(join(PACKAGE, "package-lock.json")), "package-lock.json exists beside package.json");
  assert.ok(/\bnpm ci\b/.test(CI), "CI installs dependencies with npm ci");
  for (const install of CI.matchAll(/npm install[^\n]*/g)) {
    assert.match(install[0], /--no-save/, "the only npm install in CI is the local path link, which uses --no-save");
  }
  const versions = [...CI.matchAll(/node-version: "(\d+)"/g)].map((match) => Number(match[1]));
  assert.ok(versions.length > 0, "CI declares a Node version");
  for (const major of versions) {
    assert.ok(major >= minimum, `CI uses Node ${major}, below the declared engines.node ${minimum}`);
  }
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
