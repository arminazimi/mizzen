import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { versionDiff } from "../src/outputs/version-diff.ts";

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

/** A doc page at a source file, with its Markdown body and a URL that mirrors the source path. */
function page(file: string, markdown: string, overrides: Partial<Page> = {}): Page {
  const url = `/${file.replace(/\.(?:md|markdown|mdx)$/i, "")}/`;
  return {
    url,
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The output reads no render host; the report list records any path collision. */
function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: {
      renderPage: () => Promise.reject(new Error("the version diff never renders a page")),
      report: (diagnostic) => diagnostics.push(diagnostic),
    },
  };
}

async function run(model: Site): Promise<readonly OutputFile[]> {
  return versionDiff.run(model, context().ctx);
}

function body(file: OutputFile): Record<string, unknown> {
  return JSON.parse(String(file.contents)) as Record<string, unknown>;
}

test("the output is named after its file", () => {
  assert.equal(versionDiff.name, "version-diff");
});

test("a page whose body changed writes one diff under the newer version", async () => {
  const files = await run(
    site([
      page("v1/guide/install.md", "# Install\n\nRun the old command.\n"),
      page("v2/guide/install.md", "# Install\n\nRun the new command.\n"),
    ]),
  );

  assert.equal(files.length, 1, "one changed page writes one file");
  const file = files[0]!;
  assert.equal(file.path, "diff/v2/guide/install.json");

  const json = body(file);
  assert.deepEqual(json, {
    path: "guide/install.md",
    from: "v1",
    to: "v2",
    added: [],
    removed: [],
    changed: [
      {
        heading: "Install",
        id: "install",
        occurrence: 1,
        oldText: "# Install\n\nRun the old command.\n",
        newText: "# Install\n\nRun the new command.\n",
      },
    ],
    moved: [],
  });
  assert.deepEqual(Object.keys(json), ["path", "from", "to", "added", "removed", "changed", "moved"]);
  assert.equal(String(file.contents), `${JSON.stringify(json, null, 2)}\n`, "two-space JSON with a final line feed");
});

test("identical pages, including whitespace-only edits, write no file", async () => {
  assert.deepEqual(
    await run(site([page("v1/a.md", "# A\n\nbody\n"), page("v2/a.md", "# A\n\nbody\n")])),
    [],
  );
  assert.deepEqual(
    await run(site([page("v1/a.md", "# A\n\nbody here\n"), page("v2/a.md", "# A\n\nbody   here\n")])),
    [],
    "N16 ignores whitespace-only changes",
  );
});

test("a page that exists in only one version of a pair writes no file", async () => {
  assert.deepEqual(
    await run(site([page("v1/old.md", "# Old\n"), page("v2/new.md", "# New\n")])),
    [],
    "there is no counterpart to compare",
  );

  const files = await run(
    site([
      page("v1/keep.md", "# Keep\n\nold\n"),
      page("v2/keep.md", "# Keep\n\nnew\n"),
      page("v2/only-new.md", "# Only new\n"),
    ]),
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ["diff/v2/keep.json"],
    "the page with a counterpart still writes its diff",
  );
});

test("added and removed sections are recorded, without source ranges", async () => {
  const files = await run(
    site([
      page("v1/guide.md", "# Keep\n\nsame\n\n# Gone\n\nold\n"),
      page("v2/guide.md", "# Keep\n\nsame\n\n# Fresh\n\nnew\n"),
    ]),
  );

  assert.equal(files.length, 1);
  const json = body(files[0]!);
  assert.deepEqual(json.added, [{ heading: "Fresh", id: "fresh", occurrence: 1, text: "# Fresh\n\nnew\n" }]);
  assert.deepEqual(json.removed, [{ heading: "Gone", id: "gone", occurrence: 1, text: "# Gone\n\nold\n" }]);
  assert.deepEqual(json.changed, []);
  assert.deepEqual(json.moved, []);
});

test("a reordered section is moved, and a moved section that changed keeps both texts", async () => {
  const files = await run(
    site([
      page("v1/guide.md", "# A\n\na\n\n# B\n\nb\n"),
      page("v2/guide.md", "# B\n\nb changed\n\n# A\n\na\n"),
    ]),
  );

  assert.equal(files.length, 1);
  const json = body(files[0]!);
  assert.deepEqual(json.added, []);
  assert.deepEqual(json.removed, []);
  assert.deepEqual(json.changed, []);
  assert.deepEqual(json.moved, [
    { heading: "B", id: "b", occurrence: 1, oldText: "# B\n\nb\n", newText: "# B\n\nb changed\n\n" },
  ]);
});

test("every adjacent pair is compared, and an unchanged pair writes nothing", async () => {
  const files = await run(
    site([
      page("v1/guide.md", "# Guide\n\none\n"),
      page("v2/guide.md", "# Guide\n\ntwo\n"),
      page("v3/guide.md", "# Guide\n\nthree\n"),
      page("v1/stable.md", "# Stable\n\nsame\n"),
      page("v2/stable.md", "# Stable\n\nsame\n"),
      page("v3/stable.md", "# Stable\n\nsame\n"),
    ]),
  );

  assert.deepEqual(
    files.map((file) => [file.path, body(file).from, body(file).to]),
    [
      ["diff/v2/guide.json", "v1", "v2"],
      ["diff/v3/guide.json", "v2", "v3"],
    ],
    "files are sorted by path and each names its adjacent pair",
  );
});

test("a later identical pair leaves the earlier diff in place and writes no second file", async () => {
  const files = await run(
    site([
      page("v1/a.md", "# A\n\none\n"),
      page("v2/a.md", "# A\n\ntwo\n"),
      page("v3/a.md", "# A\n\ntwo\n"),
    ]),
  );
  assert.deepEqual(
    files.map((file) => [file.path, body(file).from, body(file).to]),
    [["diff/v2/a.json", "v1", "v2"]],
  );
});

test("output keys are slugged per segment, keep the version, and never escape diff/", async () => {
  const files = await run(
    site([
      page("v1.2/Guide/My Page?.md", "# Page\n\nold\n"),
      page("v2.0/Guide/My Page?.md", "# Page\n\nnew\n"),
      page("v1.2/guide/../../secret.md", "# Secret\n\nold\n"),
      page("v2.0/guide/../../secret.md", "# Secret\n\nnew\n"),
    ]),
  );

  assert.deepEqual(
    files.map((file) => file.path),
    ["diff/v2.0/guide/my-page.json", "diff/v2.0/guide/secret.json"],
  );
  for (const file of files) {
    assert.ok(file.path.startsWith("diff/"), "every file is namespaced under diff/");
    assert.ok(!file.path.includes(".."), `no traversal segment in ${file.path}`);
    assert.ok(!file.path.includes("?"), `no unsafe character in ${file.path}`);
    assert.ok(!file.path.includes("\\"), "only / separates segments");
  }
  assert.equal(body(files[0]!).path, "Guide/My Page?.md", "the JSON keeps the version-relative source path");
  assert.equal(body(files[1]!).path, "guide/../../secret.md", "the JSON keeps the raw path as N15 reports it");
});

test("two pages whose slugs collide report the later one at its source", async () => {
  const { ctx, diagnostics } = context();
  const files = await versionDiff.run(
    site([
      page("v1/Guide/A.md", "# A\n\nold\n"),
      page("v2/Guide/A.md", "# A\n\nnew\n"),
      page("v1/guide/a.md", "# A\n\nold\n"),
      page("v2/guide/a.md", "# A\n\nnew\n"),
    ]),
    ctx,
  );

  assert.deepEqual(files.map((file) => file.path), ["diff/v2/guide/a.json"]);
  assert.equal(diagnostics.length, 1, "the second page's target is already claimed");
  assert.equal(diagnostics[0]?.id, "version-diff.path-collision");
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.equal(diagnostics[0]?.pos?.file, "v2/guide/a.md");
});

test("the same pages write the same bytes whatever order the model lists them in", async () => {
  const pages = [
    page("v1/b.md", "# B\n\nold\n"),
    page("v2/b.md", "# B\n\nnew\n"),
    page("v1/a.md", "# A\n\nold\n"),
    page("v2/a.md", "# A\n\nnew\n"),
  ];
  const first = await run(site(pages));
  const second = await run(site([...pages].reverse()));

  assert.deepEqual(
    first.map((file) => file.path),
    ["diff/v2/a.json", "diff/v2/b.json"],
    "files come back in path order",
  );
  assert.deepEqual(
    first.map((file) => [file.path, file.contents]),
    second.map((file) => [file.path, file.contents]),
  );
  for (const file of first) {
    assert.ok(!String(file.contents).includes("\r"), "the file uses LF line endings");
    assert.ok(String(file.contents).endsWith("\n"), "the file ends with a line feed");
    assert.ok(String(file.contents).includes('\n  "path":'), "the JSON uses two-space indentation");
  }
});

test("no versions, or only one version, write no files", async () => {
  assert.deepEqual(
    await run(site([page("guide/a.md", "# A\n"), page("docs/v2/b.md", "# B\n")])),
    [],
    "an unversioned page has no pair",
  );
  assert.deepEqual(
    await run(site([page("v1/a.md", "# A\n"), page("v1/b.md", "# B\n")])),
    [],
    "one version is not a pair",
  );
  assert.deepEqual(await run(site([])), []);
});

test("a page at a file URL still gets a JSON diff name", async () => {
  const files = await run(
    site([
      page("v1/guide.md", "# Guide\n\nold\n", { url: "/v1/guide.html" }),
      page("v2/guide.md", "# Guide\n\nnew\n", { url: "/v2/guide.html" }),
    ]),
  );
  assert.deepEqual(files.map((file) => file.path), ["diff/v2/guide.json"]);
});
