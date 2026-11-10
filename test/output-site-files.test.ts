import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OutputContext } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { llms } from "../src/outputs/llms.ts";
import { SITE_FILE_PATHS, siteFiles } from "../src/outputs/site-files.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** The site's own copy of each file the rule covers. Distinct bytes, so a generated file can never pass for it. */
const OWNED: Readonly<Record<string, string>> = {
  "sitemap.xml": [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    "    <loc>https://example.com/only-this/</loc>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n"),
  "llms.txt": "# Owned Site\n\n> This llms.txt is hand-written.\n\n- [Only this](https://example.com/only-this/)\n",
  "llms-full.txt": "# Owned Site\n\nHand-written for agents; the generator would list every page.\n",
  "robots.txt": "User-agent: *\r\nDisallow: /private/\r\n",
};

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "site-files-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A folder for the output; the test removes its parent. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "site-files-out-"));
  return { parent, out: join(parent, "site") };
}

/** A site that has a doc page and an app page, so every output has something to write beside the four root files. */
function siteTree(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "mizzen.yml": "title: Owned Site\nurl: https://example.com\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n\nHand-written docs.\n",
    "dashboard/index.html": "<!doctype html><title>Dashboard</title>\n",
    "dashboard/app.js": "console.log('app');\n",
    ...extra,
  };
}

function errors(diagnostics: readonly { severity: string }[]): unknown[] {
  return diagnostics.filter((d) => d.severity === "error");
}

test("a site that owns all four root files keeps its own bytes, with no generated copy and no diagnostic", async () => {
  const root = tree(siteTree(OWNED));
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics, [], "a site file replaces the generated one silently");
    for (const name of SITE_FILE_PATHS) {
      assert.deepEqual(readFileSync(join(out, name)), Buffer.from(OWNED[name] ?? ""), `${name} is the site's own copy`);
      assert.equal(result.files.filter((path) => path === name).length, 1, `${name} is written once`);
    }
    assert.ok(result.files.includes("guide/install/index.html"), "the doc page is still written");
    assert.ok(result.files.includes("dashboard/index.html"), "the app page is still written");
    assert.ok(result.files.includes("dashboard/app.js"), "the app page's files are still copied");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("a site without the four files gets the generated sitemap, llms files, and robots.txt", async () => {
  const root = tree(siteTree());
  const { parent, out } = scratch();
  try {
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics, []);

    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    assert.match(sitemap, /<loc>https:\/\/example\.com\/guide\/install\/<\/loc>/, "the doc page is in the sitemap");
    assert.doesNotMatch(sitemap, /dashboard/, "the app page is not in the sitemap");
    assert.doesNotMatch(sitemap, /only-this/, "the site's sitemap is gone");

    const guide = readFileSync(join(out, "llms.txt"), "utf8");
    assert.ok(guide.startsWith("# Owned Site\n"), guide.slice(0, 80));
    assert.match(guide, /^- \[Install\]\(https:\/\/example\.com\/guide\/install\/index\.md\)$/m);
    assert.doesNotMatch(guide, /hand-written/i, "the generated llms.txt replaces the site's");

    const full = readFileSync(join(out, "llms-full.txt"), "utf8");
    assert.ok(full.startsWith("# Owned Site\n"), full.slice(0, 80));
    assert.match(full, /Source: https:\/\/example\.com\/guide\/install\//);
    assert.match(full, /Hand-written docs\./);
    assert.doesNotMatch(full, /hand-written for agents/i);

    const robots = readFileSync(join(out, "robots.txt"), "utf8");
    assert.equal(robots, "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n");

    assert.deepEqual(
      SITE_FILE_PATHS.filter((name) => !result.files.includes(name)),
      [],
      "all four generated files are in the output",
    );
    assert.ok(result.files.includes("dashboard/index.html"));
  } finally {
    rmSync(root, { recursive: true });
    rmSync(parent, { recursive: true });
  }
});

test("switching an output off removes its generated file but never the site's own copy", async () => {
  const off = "outputs:\n  llms: false\n  llms-full: false\n  robots: false\n  sitemap: false\n";
  const owns = tree(siteTree({ ...OWNED, "mizzen.yml": `title: Owned Site\nurl: https://example.com\n${off}` }));
  const generated = tree(siteTree({ "mizzen.yml": `title: Owned Site\nurl: https://example.com\n${off}` }));
  const first = scratch();
  const second = scratch();
  try {
    const kept = await build({ root: owns, out: first.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(kept.diagnostics, []);
    for (const name of SITE_FILE_PATHS) {
      assert.deepEqual(readFileSync(join(first.out, name)), Buffer.from(OWNED[name] ?? ""), `${name} is still the site's`);
    }

    const skipped = await build({ root: generated, out: second.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(skipped.diagnostics, []);
    for (const name of SITE_FILE_PATHS) {
      assert.equal(skipped.files.includes(name), false, `${name} is not written when its output is off`);
    }
    assert.ok(skipped.files.includes("guide/install/index.html"), "only the switched-off outputs change");
  } finally {
    rmSync(owns, { recursive: true });
    rmSync(generated, { recursive: true });
    rmSync(first.parent, { recursive: true });
    rmSync(second.parent, { recursive: true });
  }
});

test("fixtures/docs-site's own llms.txt is the one in the output, not the generated one", async () => {
  const { parent, out } = scratch();
  try {
    const result = await build({ root: FIXTURE, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errors(result.diagnostics), []);
    assert.ok(
      !result.diagnostics.some((d) => d.id === "output.duplicate-path"),
      "the site's llms.txt is skipped silently",
    );
    assert.deepEqual(readFileSync(join(out, "llms.txt")), readFileSync(join(FIXTURE, "llms.txt")));

    // Prove the bytes are the site's, not the generator's: the output's own text for this model differs.
    const { site } = await buildModel(FIXTURE);
    const ctx: OutputContext = { renderPage: () => Promise.resolve(""), report: () => {} };
    const [generated] = await llms.run(site, ctx);
    assert.ok(generated, "the llms output writes a file");
    assert.notEqual(String(generated.contents), readFileSync(join(out, "llms.txt"), "utf8"));
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("the site-files unit names the four root files and writes none of its own", async () => {
  assert.equal(siteFiles.name, "site-files");
  assert.deepEqual([...SITE_FILE_PATHS], ["llms-full.txt", "llms.txt", "robots.txt", "sitemap.xml"]);
  // The unit reads neither the model nor the context: the site's copy and the pipeline's precedence write the files.
  assert.deepEqual(await siteFiles.run({} as never, {} as never), []);
});
