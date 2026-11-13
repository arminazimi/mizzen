// Same-build trust and drift evidence (#18): the theme must read the evidence this build computed, not a stale data
// file and not a second run. The tests build real sites in a git repository, render through a layout that prints
// `site.data`, and compare it with the `trust.json` and `drift.json` the same build wrote.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";
import type { TrustReport } from "../src/outputs/trust.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "same-build-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function scratch(): { parent: string; out: string; clean: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "same-build-out-"));
  return { parent, out: join(parent, "site"), clean: join(parent, "clean"), cacheDir: join(parent, "cache") };
}

/** Runs git in `root` with fixed identity and dates, so review evidence is deterministic. */
function git(root: string, args: readonly string[], date = "2026-11-01T00:00:00Z", author = "First Writer"): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: "writer@example.com",
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: "writer@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

/** A theme whose layout prints the evidence a page sees in `site.data`, plus the page body. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "same-build-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "same-build-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) => {
  const data = props.site.data as Record<string, any>;
  const trust = data.trust?.[props.page.url];
  const drift = data.drift?.[props.page.url] ?? [];
  return h(
    "html",
    null,
    h(
      "body",
      null,
      h("p", { id: "trust" }, trust?.level ?? "none"),
      h("p", { id: "reviewer" }, trust?.lastReviewer ?? "none"),
      h("p", { id: "drift" }, String(drift.length)),
      h("main", { dangerouslySetInnerHTML: { __html: props.page.html } }),
    ),
  );
};

export default doc;
`,
  );
  return root;
}

/** A two-page site with a commit, so review evidence has an answer. */
function site(): string {
  const root = tree({
    "mizzen.yml": "title: Evidence\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "alpha.md": "---\ntitle: Alpha\n---\n# Alpha\n",
  });
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "first"]);
  return root;
}

/** Reads an id's text out of one rendered page. */
function textOf(html: string, id: string): string {
  const match = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(html);
  assert.ok(match !== null, `page has #${id}`);
  return match[1]!;
}

function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs).toString("latin1"));
  }
  return map;
}

/** The environment the build's evidence and outputs use, so both look at the temporary repository. */
function withSiteEnv<T>(root: string, run: () => Promise<T>): Promise<T> {
  const before = { root: process.env.MIZZEN_SITE_ROOT, asOf: process.env.SOURCE_DATE_EPOCH };
  process.env.MIZZEN_SITE_ROOT = root;
  process.env.SOURCE_DATE_EPOCH = String(Date.parse("2026-11-13T00:00:00Z") / 1000);
  return run().finally(() => {
    if (before.root === undefined) delete process.env.MIZZEN_SITE_ROOT;
    else process.env.MIZZEN_SITE_ROOT = before.root;
    if (before.asOf === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = before.asOf;
  });
}

test("the theme sees this build's trust and drift, and they match the files the build wrote", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out } = scratch();
  try {
    await withSiteEnv(root, () => build({ root, out, themeRoot: theme, defaultLayout: "doc" }));

    const html = readFileSync(join(out, "index.html"), "utf8");
    const report = JSON.parse(readFileSync(join(out, "trust.json"), "utf8")) as TrustReport;
    const entry = report.pages["/"];
    assert.ok(entry !== undefined, "trust.json has the home page");

    assert.equal(textOf(html, "trust"), entry.level, "the panel shows the level trust.json reports");
    assert.equal(textOf(html, "reviewer"), entry.lastReviewer ?? "none", "the reviewer is the same one");
    assert.equal(textOf(html, "drift"), "0", "a page with no findings shows none");

    // A build with no history cannot claim a review either: the theme and the file must both say so.
    const bare = tree({ "mizzen.yml": "title: No git\n", "index.md": "---\ntitle: Home\n---\n# Home\n" });
    const bareOut = join(parent, "bare");
    try {
      await withSiteEnv(bare, () => build({ root: bare, out: bareOut, themeRoot: theme, defaultLayout: "doc" }));
      const bareHtml = readFileSync(join(bareOut, "index.html"), "utf8");
      const bareReport = JSON.parse(readFileSync(join(bareOut, "trust.json"), "utf8")) as TrustReport;
      assert.equal(textOf(bareHtml, "reviewer"), "none");
      assert.equal(textOf(bareHtml, "trust"), bareReport.pages["/"]!.level);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a commit moves the evidence, and a cached build never shows the old reviewer", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, cacheDir } = scratch();
  try {
    await withSiteEnv(root, () => build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir }));
    assert.equal(textOf(readFileSync(join(out, "index.html"), "utf8"), "reviewer"), "First Writer");

    writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Home\n\nReviewed again.\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "second"], "2026-11-10T00:00:00Z", "Second Writer");

    const warm = await withSiteEnv(root, () =>
      build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir }),
    );
    assert.ok(warm.renderedPages > 0, "the changed repository state re-renders the pages");
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.equal(textOf(html, "reviewer"), "Second Writer");
    assert.match(html, /Reviewed again\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a body edit re-renders one page, keeps its evidence, and equals a clean build", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    await withSiteEnv(root, () => build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir }));
    writeFileSync(join(root, "alpha.md"), "---\ntitle: Alpha\n---\n# Alpha\n\nBody, edited.\n");

    const warm = await withSiteEnv(root, () =>
      build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir }),
    );
    assert.equal(warm.renderedPages, 1, "only the edited page renders");
    assert.equal(warm.cachedPages, 1);

    await withSiteEnv(root, () => build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" }));
    assert.deepEqual(snapshot(out), snapshot(clean), "the incremental output is byte for byte the clean one");
    assert.match(readFileSync(join(out, "alpha/index.html"), "utf8"), /Body, edited\./);
    assert.equal(textOf(readFileSync(join(out, "alpha/index.html"), "utf8"), "reviewer"), "First Writer");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("drift findings from the same build reach the theme and drift.json", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out } = scratch();
  try {
    // A code reference to a file that does not exist is a drift finding computed from this build's source.
    writeFileSync(
      join(root, "alpha.md"),
      "---\ntitle: Alpha\n---\n# Alpha\n\nSee `missing/guide.md:1` for details.\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "citation"], "2026-11-10T00:00:00Z");

    await withSiteEnv(root, () => build({ root, out, themeRoot: theme, defaultLayout: "doc" }));
    const html = readFileSync(join(out, "alpha/index.html"), "utf8");
    assert.equal(textOf(html, "drift"), "1", "the page shows its finding");

    const report = JSON.parse(readFileSync(join(out, "drift.json"), "utf8")) as {
      pages: Record<string, readonly unknown[]>;
    };
    assert.equal(report.pages["/alpha/"]?.length, 1, "drift.json counts the same finding");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a site's own _data/trust.yml wins over the computed entries", async () => {
  const root = site();
  const theme = makeTheme();
  const { parent, out } = scratch();
  try {
    mkdirSync(join(root, "_data"), { recursive: true });
    writeFileSync(join(root, "_data/trust.yml"), '"/":\n  level: own-value\n');
    await withSiteEnv(root, () => build({ root, out, themeRoot: theme, defaultLayout: "doc" }));

    assert.equal(textOf(readFileSync(join(out, "index.html"), "utf8"), "trust"), "own-value");
    const report = JSON.parse(readFileSync(join(out, "trust.json"), "utf8")) as TrustReport;
    assert.notEqual(report.pages["/"]!.level, "own-value", "the report still computes its own level");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
