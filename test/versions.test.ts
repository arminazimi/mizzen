import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverVersions, type VersionPage } from "../src/content/versions.ts";

/** A page as this module reads it: a source position and a URL. */
function page(file: string, url = `/${file.replace(/\.md$/i, "")}/`): VersionPage {
  return { source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 }, url };
}

/** The entries as `version|path|status`, so a whole result reads in one assertion. */
function table(entries: readonly { version: string | null; path: string; status?: string }[]): string[] {
  return entries.map((entry) => `${entry.version ?? "-"}|${entry.path}|${entry.status ?? "-"}`);
}

test("vN, vN.M, and vN.M.P are version folders, and the rest of the path is the page path", () => {
  const pages = [page("v1/a.md"), page("v1.2/a.md"), page("v1.2.3/a.md"), page("v2/a.md")];
  assert.deepEqual(table(discoverVersions(pages)), [
    "v1|a.md|-",
    "v1.2|a.md|-",
    "v1.2.3|a.md|-",
    "v2|a.md|-",
  ]);
});

test("a page below the version folder keeps every folder in its path", () => {
  const [entry] = discoverVersions([page("v2/guide/deep/install.md")]);
  assert.equal(entry?.version, "v2");
  assert.equal(entry?.path, "guide/deep/install.md");
  assert.equal(entry?.page.source.file, "v2/guide/deep/install.md");
});

test("a version root page keeps index.md as its path", () => {
  assert.deepEqual(table(discoverVersions([page("v3/index.md")])), ["v3|index.md|-"]);
});

test("versions sort by number, not by code point", () => {
  const pages = [page("v10/a.md"), page("v2/a.md"), page("v1/a.md")];
  assert.deepEqual(
    discoverVersions(pages).map((entry) => entry.version),
    ["v1", "v2", "v10"],
  );
});

test("a deeper folder that looks like a version is not one", () => {
  assert.deepEqual(table(discoverVersions([page("guide/v2/install.md")])), ["-|guide/v2/install.md|-"]);
});

test("a documentation root moves where the version folder is looked for", () => {
  const pages = [page("docs/v2/guide/install.md"), page("docs/guide/v2/other.md")];
  assert.deepEqual(table(discoverVersions(pages, { roots: ["docs"] })), [
    "v2|guide/install.md|-",
    "-|docs/guide/v2/other.md|-",
  ]);
});

test("the longest matching root wins", () => {
  const pages = [page("docs/guide/v2/install.md")];
  assert.deepEqual(table(discoverVersions(pages, { roots: ["docs", "docs/guide"] })), ["v2|install.md|-"]);
});

test("without a root, only the first segment is a version", () => {
  assert.equal(discoverVersions([page("docs/v2/install.md")])[0]?.version, null);
});

test("a supplied list restricts detection and sets the version order", () => {
  const pages = [page("v1/a.md"), page("v2/a.md"), page("v3/a.md")];
  assert.deepEqual(table(discoverVersions(pages, { versions: ["v2", "v1"] })), [
    "v2|a.md|-",
    "v1|a.md|-",
    "-|v3/a.md|-",
  ]);
});

test("a supplied list accepts names the vN rule does not, such as next", () => {
  const pages = [page("v1/a.md"), page("next/a.md")];
  assert.deepEqual(table(discoverVersions(pages, { versions: ["v1", "next"] })), ["v1|a.md|-", "next|a.md|-"]);
});

test("a rename pairs an old path with its new path across versions", () => {
  const pages = [page("v1/guide/old-name.md"), page("v2/guide/new-name.md")];
  const entries = discoverVersions(pages, { renames: [{ from: "guide/old-name.md", to: "guide/new-name.md" }] });
  assert.deepEqual(table(entries), ["v1|guide/new-name.md|-", "v2|guide/new-name.md|-"]);
  assert.equal(entries[0]?.page.source.file, "v1/guide/old-name.md", "the page keeps its real source file");
});

test("a version-specific rename applies only to that version", () => {
  const pages = [page("v1/old.md"), page("v2/old.md"), page("v2/new.md")];
  const entries = discoverVersions(pages, { renames: [{ from: "old.md", to: "new.md", version: "v1" }] });
  // v2's `old.md` is a path v1 no longer has, because v1's page moved to `new.md`, so it reads as added.
  assert.deepEqual(table(entries), ["v1|new.md|-", "v2|new.md|-", "v2|old.md|added"]);
});

test("a renamed page is not added or removed", () => {
  const pages = [page("v1/old.md"), page("v2/new.md")];
  const entries = discoverVersions(pages, { renames: [{ from: "old.md", to: "new.md" }] });
  assert.deepEqual(
    entries.map((entry) => entry.status),
    [undefined, undefined],
  );
});

test("added and removed compare every version with the newest", () => {
  const pages = [
    page("v1/shared.md"),
    page("v1/gone.md"),
    page("v2/shared.md"),
    page("v2/fresh.md"),
  ];
  assert.deepEqual(table(discoverVersions(pages)), [
    "v1|gone.md|removed",
    "v1|shared.md|-",
    "v2|fresh.md|added",
    "v2|shared.md|-",
  ]);
});

test("a page dropped after the middle version is removed in every version without it", () => {
  const pages = [page("v1/page.md"), page("v2/page.md"), page("v3/other.md")];
  assert.deepEqual(table(discoverVersions(pages)), [
    "v1|page.md|removed",
    "v2|page.md|removed",
    "v3|other.md|added",
  ]);
});

test("one version alone reports no added or removed pages", () => {
  const entries = discoverVersions([page("v1/a.md"), page("v1/b.md")]);
  assert.deepEqual(
    entries.map((entry) => entry.status),
    [undefined, undefined],
  );
});

test("pages outside every version come last with a null version", () => {
  const pages = [page("z.md"), page("v2/a.md"), page("a/b.md")];
  assert.deepEqual(table(discoverVersions(pages)), ["v2|a.md|-", "-|a/b.md|-", "-|z.md|-"]);
});

test("detection reads the source file, never the URL", () => {
  const pages = [page("v2/install.md", "/latest/install/"), page("guide/install.md", "/v1/install/")];
  assert.deepEqual(table(discoverVersions(pages)), ["v2|install.md|-", "-|guide/install.md|-"]);
});

test("backslashes in a source path are read as folder separators", () => {
  const [entry] = discoverVersions([page("v2\\guide\\install.md")]);
  assert.equal(entry?.version, "v2");
  assert.equal(entry?.path, "guide/install.md");
});

test("the same pages in any input order give the same result", () => {
  const pages = [
    page("v2/z.md"),
    page("unversioned.md"),
    page("v10/a.md"),
    page("v1/m.md"),
    page("v2/a.md"),
  ];
  assert.deepEqual(discoverVersions(pages), discoverVersions([...pages].reverse()));
});

test("the same path twice in one version keeps a stable order by source file", () => {
  const pages = [page("v2/new.md"), page("v2/old.md")];
  const entries = discoverVersions(pages, { renames: [{ from: "old.md", to: "new.md" }] });
  assert.deepEqual(
    entries.map((entry) => entry.page.source.file),
    ["v2/new.md", "v2/old.md"],
  );
  const reversed = discoverVersions([...pages].reverse(), { renames: [{ from: "old.md", to: "new.md" }] });
  assert.deepEqual(
    reversed.map((entry) => entry.page.source.file),
    ["v2/new.md", "v2/old.md"],
  );
});

test("no pages is an empty result", () => {
  assert.deepEqual(discoverVersions([]), []);
});
