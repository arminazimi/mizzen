import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";
import { permalink } from "../src/content/permalink.ts";
import { loadNavigation, navFromYaml } from "../src/nav/from-yaml.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site/", import.meta.url));

/** Every page URL of a source folder, Markdown pages and app pages alike, as the engine derives them. */
async function pagesOf(source: string): Promise<Set<string>> {
  const files = await discover(source);
  return new Set(files.filter((f) => f.kind === "doc" || f.kind === "app").map((f) => permalink(f.path)));
}

test("the docs-site fixture navigation loads with no diagnostics, and every link is a page", async () => {
  const text = readFileSync(join(FIXTURE, "_data/navigation.yml"), "utf8");
  const result = navFromYaml(text, "_data/navigation.yml", { pages: await pagesOf(FIXTURE) });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.keys(result.nav), ["main"]);
  assert.equal(result.nav.main?.length, 7);
});

test("the 0.2 shape: main, docs, and per-language lists, with groups, children, and match", () => {
  const text = [
    "main:",
    "  - title: Home",
    "    url: /",
    "docs:",
    "  - title: Start",
    "    children:",
    "      - title: Install",
    "        url: /install/",
    "  - title: Reference",
    "    url: /reference/",
    "    match: /reference/",
    "docs_fa:",
    "  - title: شروع",
    "    url: /fa/install/",
    "",
  ].join("\n");
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(nav, {
    main: [{ title: "Home", url: "/" }],
    docs: [
      { title: "Start", children: [{ title: "Install", url: "/install/" }] },
      { title: "Reference", url: "/reference/", match: "/reference/" },
    ],
    docs_fa: [{ title: "شروع", url: "/fa/install/" }],
  });
});

test("an https link and a language suffix of three letters are accepted", () => {
  const text = "main:\n  - title: Source\n    url: https://github.com/arminazimi/slipway\ndocs_fil:\n  - title: Home\n    url: /\n";
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(nav.main, [{ title: "Source", url: "https://github.com/arminazimi/slipway" }]);
  assert.deepEqual(nav.docs_fil, [{ title: "Home", url: "/" }]);
});

test("an unknown URL is an error with its YAML line, and that entry is left out", () => {
  const text = [
    "docs:",
    "  - title: Install",
    "    url: install/",
    "  - title: Quickstart",
    "    url: /quickstart/",
    "",
  ].join("\n");
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "nav.invalid-url");
  assert.equal(diagnostics[0]?.severity, "error");
  assert.equal(diagnostics[0]?.pos?.line, 3);
  assert.deepEqual(nav.docs, [{ title: "Quickstart", url: "/quickstart/" }]);
});

test("a site-local link to a page that does not exist is a warning with its YAML line", () => {
  const text = "docs:\n  - title: Install\n    url: /install/\n  - title: Gone\n    url: /gone/\n";
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml", { pages: new Set(["/install/"]) });
  assert.deepEqual(diagnostics.map((d) => [d.id, d.severity, d.pos?.line]), [["nav.unknown-url", "warning", 5]]);
  assert.equal(nav.docs?.length, 2);
});

test("without a page set only the shape of the file is checked", () => {
  const text = "docs:\n  - title: Gone\n    url: /gone/\n";
  assert.deepEqual(navFromYaml(text, "_data/navigation.yml").diagnostics, []);
});

test("an unknown list name and an unknown key are errors with their YAML line", () => {
  const text = [
    "footer:",
    "  - title: Home",
    "    url: /",
    "docs:",
    "  - title: Home",
    "    url: /",
    "    icon: home",
    "",
  ].join("\n");
  const { diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(
    diagnostics.map((d) => [d.id, d.pos?.line]),
    [["nav.unknown-list", 1], ["nav.unknown-key", 7]],
  );
});

test("a group with no children, or a group nested in a group, is an error", () => {
  const text = [
    "docs:",
    "  - title: Empty",
    "    children: []",
    "  - title: Outer",
    "    children:",
    "      - title: Inner",
    "        children:",
    "          - title: Deep",
    "            url: /deep/",
    "",
  ].join("\n");
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics.map((d) => [d.id, d.pos?.line]), [
    ["nav.invalid-item", 3],
    ["nav.unknown-key", 7],
    ["nav.invalid-item", 6],
  ]);
  assert.deepEqual(nav.docs, []);
});

test("a match that is not a path prefix is an error", () => {
  const text = "docs:\n  - title: Rules\n    url: /rules/\n    match: rules\n";
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics.map((d) => [d.id, d.pos?.line]), [["nav.invalid-match", 4]]);
  assert.deepEqual(nav.docs, []);
});

test("invalid YAML reports the line of the syntax error and loads nothing", () => {
  const { nav, diagnostics } = navFromYaml("docs:\n  - title: [oops\n", "_data/navigation.yml");
  assert.equal(diagnostics[0]?.id, "nav.invalid-yaml");
  assert.equal(diagnostics[0]?.severity, "error");
  assert.equal(diagnostics[0]?.pos?.file, "_data/navigation.yml");
  assert.ok((diagnostics[0]?.pos?.line ?? 0) >= 2);
  assert.deepEqual(nav, {});
});

test("an empty file is an empty navigation, and a file that is not a mapping is an error", () => {
  assert.deepEqual(navFromYaml("", "_data/navigation.yml"), { nav: {}, diagnostics: [] });
  const { diagnostics } = navFromYaml("- title: Home\n  url: /\n", "_data/navigation.yml");
  assert.deepEqual(diagnostics.map((d) => d.id), ["nav.not-a-mapping"]);
});

test("site-local URLs and match prefixes carry the site base, and the page check uses the prefixed URL", () => {
  const text = [
    "main:",
    "  - title: Home",
    "    url: /",
    "  - title: Config",
    "    url: /config/",
    "  - title: Source",
    "    url: https://example.com/source",
    "docs:",
    "  - title: Rules",
    "    url: /rules/",
    "    match: /rules/",
    "",
  ].join("\n");
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml", {
    base: "/docs",
    pages: new Set(["/docs/", "/docs/config/", "/docs/rules/"]),
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(nav.main, [
    { title: "Home", url: "/docs/" },
    { title: "Config", url: "/docs/config/" },
    { title: "Source", url: "https://example.com/source" },
  ]);
  assert.deepEqual(nav.docs, [{ title: "Rules", url: "/docs/rules/", match: "/docs/rules/" }]);
});

test("tab: true rides along on a link and a group; tab: false is dropped", () => {
  const text = [
    "main:",
    "  - title: Guides",
    "    url: /guides/",
    "    tab: true",
    "  - title: Reference",
    "    tab: true",
    "    children:",
    "      - title: Config",
    "        url: /config/",
    "  - title: Home",
    "    url: /",
    "    tab: false",
    "",
  ].join("\n");
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(nav.main, [
    { title: "Guides", url: "/guides/", tab: true },
    { title: "Reference", tab: true, children: [{ title: "Config", url: "/config/" }] },
    { title: "Home", url: "/" },
  ]);
});

test("a tab that is not a boolean is an error, and the entry still loads without it", () => {
  const text = "main:\n  - title: Guides\n    url: /guides/\n    tab: yes please\n";
  const { nav, diagnostics } = navFromYaml(text, "_data/navigation.yml");
  assert.deepEqual(diagnostics.map((d) => [d.id, d.severity, d.pos?.line]), [["nav.invalid-tab", "error", 4]]);
  assert.deepEqual(nav.main, [{ title: "Guides", url: "/guides/" }]);
});

test("a missing navigation file is an empty navigation with no diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "nav-yaml-"));
  try {
    assert.deepEqual(loadNavigation(join(root, "_data/navigation.yml"), "_data/navigation.yml"), { nav: {}, diagnostics: [] });
    writeFileSync(join(root, "navigation.yml"), "main:\n  - title: Home\n    url: /\n");
    assert.deepEqual(loadNavigation(join(root, "navigation.yml"), "navigation.yml").nav.main, [{ title: "Home", url: "/" }]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
