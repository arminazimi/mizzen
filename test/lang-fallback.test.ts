import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  fallbackChain,
  languageGroups,
  resolveLanguage,
  translationId,
} from "../src/content/lang-fallback.ts";
import { buildModel } from "../src/model/build.ts";
import type { FrontMatter, Page, Site, SiteConfig } from "../src/contracts/index.ts";

const CONFIG: SiteConfig = {
  title: "Test",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  defaults: [],
  theme: {},
  search: {},
  redirects: {},
  outputs: {},
};

const LANGUAGES = [
  { code: "en", name: "English", prefix: "" },
  { code: "fa", name: "فارسی", prefix: "/fa" },
] as const;

function page(url: string, lang: string, translationKey?: string): Page {
  const frontMatter: FrontMatter = translationKey === undefined ? {} : { translation_key: translationKey };
  return {
    url,
    source: { file: "fixture.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter,
    title: url,
    lang,
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[], config: Partial<SiteConfig> = {}, data: Record<string, unknown> = {}): Site {
  return { config: { ...CONFIG, ...config }, pages, nav: {}, data };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lang-fallback-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("translation_key groups pages that live at different URLs", () => {
  const config = { base: "", languages: LANGUAGES };
  const en = page("/guide/install/", "en", "install");
  const fa = page("/fa/guide/install/", "fa", "install");

  assert.equal(translationId(en, config), "install");
  // The key wins over the URL, even when the URL shape also gives an identity.
  assert.equal(translationId(fa, config), "install");

  const groups = languageGroups(site([fa, en], config));
  assert.deepEqual(
    groups.get("install")?.map((entry) => entry.lang),
    ["en", "fa"],
  );
});

test("without a translation_key the URL minus its language prefix is the identity", () => {
  const config = { base: "/docs", languages: LANGUAGES };

  assert.equal(translationId(page("/docs/guide/install/", "en"), config), "/guide/install/");
  assert.equal(translationId(page("/docs/fa/guide/install/", "fa"), config), "/guide/install/");
  assert.equal(translationId(page("/docs/", "en"), config), "/");
  assert.equal(translationId(page("/docs/fa/", "fa"), config), "/");
  // Only whole segments are a prefix: `/fabric/` is not Persian.
  assert.equal(translationId(page("/docs/fabric/", "en"), config), "/fabric/");

  const groups = languageGroups(site([page("/docs/guide/install/", "en"), page("/docs/fa/guide/install/", "fa")], config));
  assert.deepEqual(
    groups.get("/guide/install/")?.map((entry) => entry.url),
    ["/docs/guide/install/", "/docs/fa/guide/install/"],
  );
});

test("the longest configured prefix wins when prefixes overlap", () => {
  const config = {
    base: "",
    languages: [
      { code: "ja", name: "日本語", prefix: "/ja" },
      { code: "ja-jp", name: "日本語", prefix: "/ja-jp" },
    ],
  };
  assert.equal(translationId(page("/ja-jp/guide/", "ja-jp"), config), "/guide/");
  assert.equal(translationId(page("/ja/guide/", "ja"), config), "/guide/");
});

test("a regional tag falls back to its shorter form before the chain", () => {
  const config = { lang: "en", base: "", languages: [{ code: "pt", name: "Português", prefix: "/pt" }, ...LANGUAGES] };
  const pt = page("/pt/guia/", "pt", "guide");
  const en = page("/guia/", "en", "guide");
  const model = site([en, pt], config);

  // A pt-BR translation that was never written: its key finds the pt page.
  const wanted = page("/pt-BR/guia/", "pt-BR", "guide");
  assert.deepEqual(resolveLanguage(model, wanted, ["en"]), { page: pt, lang: "pt", fallback: true });

  // The exact tag wins when it exists, and is not a fallback.
  const br = page("/pt-BR/guia/", "pt-BR", "guide");
  const withBr = site([en, pt, br], config);
  assert.deepEqual(resolveLanguage(withBr, wanted, ["en"]), { page: br, lang: "pt-BR", fallback: false });

  // A chain entry may be regional too: pt-BR resolves to pt.
  assert.equal(resolveLanguage(site([page("/pt/guia/", "pt", "guide")], config), wanted, ["pt-BR"])?.lang, "pt");
  // Without a pt page, pt-BR in the chain matches nothing.
  assert.equal(resolveLanguage(site([en], config), wanted, ["pt-BR"]), undefined);
});

test("the fallback chain is walked in order", () => {
  const config = { lang: "en", base: "", languages: [{ code: "fa", name: "فارسی", prefix: "/fa" }, ...LANGUAGES] };
  const en = page("/guide/", "en", "guide");
  const fa = page("/fa/guide/", "fa", "guide");
  const de = page("/de/guide/", "de", "guide");

  // The requested language is not available: the first chain language that has a page wins.
  assert.equal(resolveLanguage(site([en, fa, de], config), page("/xx/guide/", "xx", "guide"), ["fa", "en"])?.lang, "fa");
  assert.equal(resolveLanguage(site([en], config), page("/xx/guide/", "xx", "guide"), ["fa", "en"])?.lang, "en");
  // A later chain entry is not used when an earlier one exists.
  assert.equal(resolveLanguage(site([en, fa], config), page("/xx/guide/", "xx", "guide"), ["fa"])?.lang, "fa");
  // The page's own language wins over every chain entry.
  assert.equal(resolveLanguage(site([en, fa, de], config), de, ["fa", "en"])?.lang, "de");
});

test("a missing translation resolves to undefined", () => {
  const config = { lang: "en", base: "", languages: LANGUAGES };
  const model = site([page("/guide/", "en", "guide")], config);

  assert.equal(resolveLanguage(model, page("/xx/guide/", "xx", "other"), ["en"]), undefined);
  // An empty chain means no fallback beyond the requested tag and its shorter forms.
  assert.equal(resolveLanguage(model, page("/xx/guide/", "xx", "guide"), []), undefined);
});

test("without a chain, resolveLanguage uses the site default language", () => {
  const config = { lang: "en", base: "", languages: LANGUAGES };
  const model = site([page("/guide/", "en", "guide")], config);
  assert.deepEqual(resolveLanguage(model, page("/fa/guide/", "fa", "guide")), {
    page: model.pages[0],
    lang: "en",
    fallback: true,
  });
});

test("fallbackChain reads _data/languages.yml and defaults to the site language", () => {
  assert.deepEqual(fallbackChain({ lang: "en" }, {}), ["en"]);
  assert.deepEqual(fallbackChain({ lang: "en" }, { languages: { fallback: ["fa", "en"] } }), ["fa", "en"]);
  assert.deepEqual(fallbackChain({ lang: "fa" }, { languages: { fallback: ["fa"] } }), ["fa"]);
  // Entries are trimmed and junk is dropped.
  assert.deepEqual(fallbackChain({ lang: "en" }, { languages: { fallback: [" fa ", 42, "", "en"] } }), ["fa", "en"]);
  // An explicit empty list is kept: it means no fallback.
  assert.deepEqual(fallbackChain({ lang: "en" }, { languages: { fallback: [] } }), []);
  // A list with no usable entry, or a different shape, falls back to the site language.
  assert.deepEqual(fallbackChain({ lang: "en" }, { languages: { fallback: [42, null] } }), ["en"]);
  assert.deepEqual(fallbackChain({ lang: "en" }, { languages: ["fa", "en"] }), ["en"]);
});

test("languageGroups is deterministic whatever order the pages arrive in", () => {
  const config = { lang: "en", base: "", languages: LANGUAGES };
  const pages = [
    page("/zh/guide/", "zh", "guide"),
    page("/fa/guide/", "fa", "guide"),
    page("/guide/", "en", "guide"),
    page("/zh/other/", "zh", "other"),
    page("/guide/other/", "en", "other"),
    page("/fa/other/", "fa", "other"),
  ];

  const forward = languageGroups(site(pages, config));
  const backward = languageGroups(site([...pages].reverse(), config));

  assert.deepEqual([...forward.keys()], [...backward.keys()]);
  assert.deepEqual(
    [...forward.entries()].map(([id, group]) => [id, group.map((entry) => entry.url)]),
    [...backward.entries()].map(([id, group]) => [id, group.map((entry) => entry.url)]),
  );
  assert.deepEqual(forward.get("guide")?.map((entry) => entry.lang), ["en", "fa", "zh"]);
  // `other` sorts after `guide` because its first page (`/guide/other/`) comes after `/fa/guide/` by URL.
  assert.deepEqual([...forward.keys()], ["guide", "other"]);
});

test("a built site groups pages and falls back from _data/languages.yml", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Multilingual",
      "base: /docs",
      "lang: en",
      "languages:",
      '  - code: en',
      "    name: English",
      '    prefix: ""',
      "  - code: fa",
      "    name: فارسی",
      "    prefix: /fa",
      "",
    ].join("\n"),
    "_data/languages.yml": "fallback:\n  - fa\n  - en\n",
    "guide/install.md": "---\ntranslation_key: install\n---\n# Install\n",
    "fa/guide/install.md": "---\ntranslation_key: install\n---\n# نصب\n",
  });

  try {
    const { site: model, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(fallbackChain(model.config, model.data), ["fa", "en"]);

    const groups = languageGroups(model);
    assert.deepEqual(groups.get("install")?.map((entry) => entry.url), [
      "/docs/guide/install/",
      "/docs/fa/guide/install/",
    ]);

    const wanted = page("/docs/pt/guide/install/", "pt", "install");
    assert.deepEqual(resolveLanguage(model, wanted)?.lang, "fa");
    assert.equal(resolveLanguage(model, wanted)?.fallback, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
