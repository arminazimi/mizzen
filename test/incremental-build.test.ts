// Incremental builds end to end: a focused edit re-renders the pages whose inputs changed, the rest are reused, and
// the bytes written are exactly the bytes of a clean build. The invalidation plan that explains the work is checked
// against the dependency graph, so the "expected" set is not the same code that decided to skip.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readFileSync as read, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";
import { outputNodeId } from "../src/pipeline/dependency-graph.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "incremental-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Outputs and the cache live beside the site, never inside it. */
function scratch(): { parent: string; out: string; clean: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "incremental-out-"));
  return { parent, out: join(parent, "site"), clean: join(parent, "clean"), cacheDir: join(parent, "cache") };
}

/**
 * A theme whose layout renders the page body, the site title, every page title, and the navigation. Reading every title
 * is deliberate: the render cache must retire all pages when a title changes, and keep them when only a body changes.
 */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "incremental-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "incremental-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) =>
  h(
    "html",
    null,
    h(
      "body",
      null,
      h("h1", { id: "site" }, props.site.config.title),
      h("ul", { id: "titles" }, props.site.pages.map((page) => h("li", { key: page.url }, page.title))),
      h("pre", { id: "nav" }, JSON.stringify(props.site.nav)),
      h("main", { dangerouslySetInnerHTML: { __html: props.page.html } }),
    ),
  );

export default doc;
`,
  );
  return root;
}

/** Every file under `dir` as path → bytes, so two builds compare byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), read(abs).toString("latin1"));
  }
  return map;
}

/** A three-page site plus one snippet that `alpha.md` includes. */
function site(): string {
  return tree({
    "mizzen.yml": "title: Incremental\n",
    "_data/navigation.yml": "main:\n  - title: Home\n    url: /\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n",
    "_snippets/shared.md": "Shared snippet.\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "alpha.md": "---\ntitle: Alpha\n---\n# Alpha\n\nBody.\n\n::include[_snippets/shared.md]\n",
    "beta.md": "---\ntitle: Beta\n---\n# Beta\n\nBody.\n",
  });
}

test("a body edit re-renders one page, and the output matches a clean build byte for byte", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    const cold = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(cold.renderedPages, 3, "the first build renders every page");
    assert.equal(cold.cachedPages, 0);
    assert.equal(cold.invalidation, undefined, "a cold build has no narrower plan");

    writeFileSync(join(root, "alpha.md"), "---\ntitle: Alpha\n---\n# Alpha\n\nBody, edited.\n\n::include[_snippets/shared.md]\n");

    const warm = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(warm.renderedPages, 1, "only the edited page renders");
    assert.equal(warm.cachedPages, 2, "the other pages are reused");
    assert.ok(warm.invalidation !== undefined, "a warm build explains its work");
    assert.equal(warm.invalidation.complete, false);
    assert.deepEqual(
      warm.invalidation.outputs.map((output) => output.id),
      [outputNodeId("/alpha/")],
      "the plan names only the edited page's output",
    );
    assert.equal(warm.invalidation.outputs[0]!.direct[0]!.node, "file:alpha.md");

    // A clean build from the same source is the reference: the incremental one must be identical, not merely close.
    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
    assert.match(readFileSync(join(out, "alpha/index.html"), "utf8"), /Body, edited\./);
    assert.doesNotMatch(readFileSync(join(out, "beta/index.html"), "utf8"), /Body, edited\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a title change retires every page render, because every page shows every title", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    writeFileSync(join(root, "alpha.md"), "---\ntitle: Alpha renamed\n---\n# Alpha\n\nBody.\n\n::include[_snippets/shared.md]\n");

    const warm = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(warm.renderedPages, 3, "a renamed page is visible on every other page, so every page renders");
    assert.equal(warm.cachedPages, 0);
    assert.equal(warm.invalidation, undefined, "a settings change has no narrow plan");

    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
    assert.match(readFileSync(join(out, "beta/index.html"), "utf8"), /Alpha renamed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a snippet edit re-renders its includers only, and still matches a clean build", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    writeFileSync(join(root, "_snippets/shared.md"), "Shared snippet, edited.\n");

    const warm = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(warm.renderedPages, 1, "only the page that includes the snippet renders");
    assert.equal(warm.cachedPages, 2);
    assert.deepEqual(warm.invalidation?.outputs.map((output) => output.id), [outputNodeId("/alpha/")]);
    assert.deepEqual(warm.invalidation?.outputs[0]!.transitive[0]!.chain.map((step) => step.path), [
      "/alpha/",
      "alpha.md",
      "_snippets/shared.md",
    ]);

    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
    assert.match(readFileSync(join(out, "alpha/index.html"), "utf8"), /Shared snippet, edited\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an unchanged rebuild is one cache hit and renders nothing", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const again = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(again.renderedPages, 0);
    assert.equal(again.cachedPages, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a corrupt page render is a miss, never stale output", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const renderDirs = readdirSync(join(cacheDir, "render"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(renderDirs.length, 1);
    const dir = join(cacheDir, "render", renderDirs[0]!.name);
    for (const entry of readdirSync(dir)) writeFileSync(join(dir, entry), "{not json\n");

    writeFileSync(join(root, "beta.md"), "---\ntitle: Beta\n---\n# Beta\n\nBody, edited.\n");
    const warm = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(warm.renderedPages, 3, "an unreadable render is rendered again");
    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
    assert.match(readFileSync(join(out, "beta/index.html"), "utf8"), /Body, edited\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
