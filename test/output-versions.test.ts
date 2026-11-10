import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { versions } from "../src/outputs/versions.ts";
import { build } from "../src/pipeline/build.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

/** A page whose source file is `file` and whose URL is the file without `.md` unless given. */
function page(file: string, url = `/${file.replace(/\.md$/i, "")}/`): Page {
  return {
    url,
    source: { ...pos, file },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The versions output reads only the model, so rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the versions output never renders a page")),
  report: () => {},
};

interface VersionEntry {
  readonly version: string;
  readonly url: string;
  readonly status?: string;
}

interface VersionsPage {
  readonly path: string;
  readonly versions: readonly VersionEntry[];
}

interface VersionsJson {
  readonly pages: readonly VersionsPage[];
  readonly byUrl: Readonly<Record<string, string>>;
}

/** The parsed file, with the raw text too so a test can check the bytes. */
async function run(model: Site): Promise<{ text: string; json: VersionsJson } | undefined> {
  const files = await versions.run(model, ctx);
  if (files.length === 0) return undefined;
  assert.equal(files.length, 1, "the output writes one file");
  const text = String(files[0]!.contents);
  return { text, json: JSON.parse(text) as VersionsJson };
}

/** The file's `path|version:url:status` rows, so a whole result reads in one assertion. */
function table(json: VersionsJson): string[] {
  return json.pages.flatMap((page) =>
    page.versions.map((entry) => `${page.path}|${entry.version}|${entry.url}|${entry.status ?? "-"}`),
  );
}

test("the output is named after its file and writes versions.json with two-space JSON and a final LF", async () => {
  assert.equal(versions.name, "versions");
  const result = await run(site([page("v1/install.md")]));
  assert.ok(result, "a versioned site writes the file");
  assert.equal(result.text.endsWith("\n"), true, "the file ends with a line feed");
  assert.equal(result.text, `${JSON.stringify(result.json, null, 2)}\n`, "two spaces of indentation");
  assert.ok(result.text.includes('\n  "pages": ['), "the top-level keys are indented by two spaces");
});

test("one version gives every page one entry", async () => {
  const result = await run(site([page("v1/install.md"), page("v1/guide/deep/setup.md")]));
  assert.ok(result);
  assert.deepEqual(table(result.json), [
    "guide/deep/setup.md|v1|/v1/guide/deep/setup/|-",
    "install.md|v1|/v1/install/|-",
  ]);
  assert.deepEqual(result.json.byUrl, {
    "/v1/guide/deep/setup/": "guide/deep/setup.md",
    "/v1/install/": "install.md",
  });
});

test("two versions of one path share an entry, in version order", async () => {
  const result = await run(site([page("v2/install.md"), page("v1/install.md")]));
  assert.ok(result);
  assert.equal(result.json.pages.length, 1, "the same path is one page");
  assert.deepEqual(table(result.json), ["install.md|v1|/v1/install/|-", "install.md|v2|/v2/install/|-"]);
  assert.deepEqual(result.json.byUrl, {
    "/v1/install/": "install.md",
    "/v2/install/": "install.md",
  });
});

test("versions sort by number, not by code point", async () => {
  const result = await run(site([page("v10/a.md"), page("v2/a.md"), page("v1/a.md")]));
  assert.ok(result);
  assert.deepEqual(
    result.json.pages[0]?.versions.map((entry) => entry.version),
    ["v1", "v2", "v10"],
  );
});

test("nested pages keep their folder below the version", async () => {
  const result = await run(site([page("v2/guide/deep/install.md"), page("v1/guide/deep/install.md")]));
  assert.ok(result);
  assert.deepEqual(result.json.pages, [
    {
      path: "guide/deep/install.md",
      versions: [
        { version: "v1", url: "/v1/guide/deep/install/" },
        { version: "v2", url: "/v2/guide/deep/install/" },
      ],
    },
  ]);
});

test("a page in a single version among several gets one entry", async () => {
  const result = await run(site([page("v1/shared.md"), page("v2/shared.md"), page("v2/fresh.md")]));
  assert.ok(result);
  const fresh = result.json.pages.find((page) => page.path === "fresh.md");
  assert.deepEqual(fresh?.versions, [{ version: "v2", url: "/v2/fresh/", status: "added" }]);
});

test("added and removed pages carry status on the version that differs; unchanged pages omit the key", async () => {
  const result = await run(
    site([page("v1/shared.md"), page("v1/gone.md"), page("v2/shared.md"), page("v2/fresh.md")]),
  );
  assert.ok(result);
  assert.deepEqual(table(result.json), [
    "fresh.md|v2|/v2/fresh/|added",
    "gone.md|v1|/v1/gone/|removed",
    "shared.md|v1|/v1/shared/|-",
    "shared.md|v2|/v2/shared/|-",
  ]);
  const shared = result.json.pages.find((page) => page.path === "shared.md");
  for (const entry of shared?.versions ?? []) {
    assert.equal("status" in entry, false, "an unchanged page has no status key");
  }
});

test("a path dropped after the middle version is removed in every version without it", async () => {
  const result = await run(site([page("v1/install.md"), page("v2/install.md"), page("v3/other.md")]));
  assert.ok(result);
  assert.deepEqual(table(result.json), [
    "install.md|v1|/v1/install/|removed",
    "install.md|v2|/v2/install/|removed",
    "other.md|v3|/v3/other/|added",
  ]);
});

test("a site with no versioned page writes no file", async () => {
  assert.equal(await run(site([page("guide/install.md"), page("about.md")])), undefined);
  assert.equal(await run(site([])), undefined);
});

test("unversioned pages are left out when the site also has versioned pages", async () => {
  const result = await run(site([page("about.md"), page("v1/install.md")]));
  assert.ok(result);
  assert.deepEqual(
    result.json.pages.map((page) => page.path),
    ["install.md"],
  );
  assert.deepEqual(Object.keys(result.json.byUrl), ["/v1/install/"]);
});

test("pages sort by path, whatever order the model came in", async () => {
  const pages = [page("v1/z.md"), page("v1/a/deep.md"), page("v1/b.md")];
  const first = await run(site(pages));
  const second = await run(site([...pages].reverse()));
  assert.ok(first && second);
  assert.deepEqual(
    first.json.pages.map((page) => page.path),
    ["a/deep.md", "b.md", "z.md"],
  );
  assert.equal(first.text, second.text, "the same pages give the same bytes");
  assert.equal(first.text, (await run(site(pages)))?.text, "two runs give the same bytes");
});

test("URLs keep base, and the file stays at the output root", async () => {
  const result = await run(
    site([page("v1/install.md", "/docs/v1/install/"), page("v2/install.md", "/docs/v2/install/")], {
      base: "/docs",
    }),
  );
  assert.ok(result);
  assert.deepEqual(table(result.json), [
    "install.md|v1|/docs/v1/install/|-",
    "install.md|v2|/docs/v2/install/|-",
  ]);
  assert.deepEqual(result.json.byUrl, {
    "/docs/v1/install/": "install.md",
    "/docs/v2/install/": "install.md",
  });
  const files = await versions.run(
    site([page("v1/install.md", "/docs/v1/install/")], { base: "/docs" }),
    ctx,
  );
  assert.equal(files[0]?.path, "versions.json", "the file is not written under base");
});

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "versions-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("a build writes versions.json through the output registry", async () => {
  const root = tree({
    "mizzen.yml": ["title: Example", "base: /docs", ""].join("\n"),
    "v1/guide/install.md": "---\ntitle: Install v1\n---\n# Install\n",
    "v2/guide/install.md": "---\ntitle: Install v2\n---\n# Install\n",
    "about.md": "---\ntitle: About\n---\n# About\n",
  });
  const parent = mkdtempSync(join(tmpdir(), "versions-out-"));
  const out = join(parent, "site");
  try {
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );

    const text = readFileSync(join(out, "versions.json"), "utf8");
    const json = JSON.parse(text) as VersionsJson;
    assert.deepEqual(table(json), [
      "guide/install.md|v1|/docs/v1/guide/install/|-",
      "guide/install.md|v2|/docs/v2/guide/install/|-",
    ]);
    assert.equal(
      Object.hasOwn(json.byUrl, "/docs/about/"),
      false,
      "the unversioned page is not in the file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
