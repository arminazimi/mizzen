import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LanguageConfig, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { hreflangLinks } from "../src/outputs/hreflang.ts";
import { build } from "../src/pipeline/build.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

const LANGUAGES: readonly LanguageConfig[] = [
  { code: "en", name: "English", prefix: "" },
  { code: "fa", name: "فارسی", prefix: "/fa" },
  { code: "ar", name: "العربية", prefix: "/ar" },
];

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

function page(url: string, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** The translation group the tests use: English at the root, Persian and Arabic under their prefixes. */
function translations(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return site(pages, { languages: LANGUAGES, ...overrides });
}

test("every language of a translation group gets one alternate, the page's own included", () => {
  const en = page("/guide/install/");
  const fa = page("/fa/guide/install/", { lang: "fa", dir: "rtl" });
  const ar = page("/ar/guide/install/", { lang: "ar", dir: "rtl" });
  const model = translations([ar, en, fa]);

  const expected = [
    { rel: "alternate", href: "/ar/guide/install/", attrs: { hreflang: "ar" } },
    { rel: "alternate", href: "/guide/install/", attrs: { hreflang: "en" } },
    { rel: "alternate", href: "/fa/guide/install/", attrs: { hreflang: "fa" } },
    { rel: "alternate", href: "/guide/install/", attrs: { hreflang: "x-default" } },
  ];
  assert.deepEqual(hreflangLinks(model, en), expected);
  assert.deepEqual(hreflangLinks(model, fa), expected, "the Persian page lists the same alternates, itself included");
  assert.deepEqual(hreflangLinks(model, ar), expected);
});

test("x-default is last and points at the default language's page", () => {
  const en = page("/guide/install/");
  const fa = page("/fa/guide/install/", { lang: "fa", dir: "rtl" });
  const links = hreflangLinks(translations([en, fa]), fa);

  const fallback = links.at(-1);
  assert.deepEqual(fallback, { rel: "alternate", href: "/guide/install/", attrs: { hreflang: "x-default" } });
  assert.equal(links.filter((link) => link.attrs?.["hreflang"] === "x-default").length, 1);
});

test("a group without the default language has no x-default", () => {
  const fa = page("/fa/guide/install/", { lang: "fa", dir: "rtl" });
  const ar = page("/ar/guide/install/", { lang: "ar", dir: "rtl" });
  const links = hreflangLinks(translations([fa, ar]), fa);

  assert.deepEqual(
    links.map((link) => link.attrs?.["hreflang"]),
    ["ar", "fa"],
  );
});

test("a page whose group has one language gets nothing", () => {
  assert.deepEqual(hreflangLinks(site([page("/guide/install/")]), page("/guide/install/")), []);

  const first = page("/guide/install/", { frontMatter: { translation_key: "install" } });
  const second = page("/guide/old/", { frontMatter: { translation_key: "install" } });
  assert.deepEqual(
    hreflangLinks(site([first, second]), first),
    [],
    "two pages in one language are still a single-language group",
  );

  const fa = page("/fa/guide/install/", { lang: "fa", dir: "rtl" });
  const faAgain = page("/fa/old/install/", { lang: "fa", dir: "rtl", frontMatter: { translation_key: "/guide/install/" } });
  assert.deepEqual(hreflangLinks(translations([fa, faAgain]), fa), []);
});

test("the href is absolute with a site url and the page url without one", () => {
  const en = page("/guide/install/");
  const fa = page("/fa/guide/install/", { lang: "fa", dir: "rtl" });

  assert.deepEqual(
    hreflangLinks(translations([en, fa]), en).map((link) => link.href),
    ["/guide/install/", "/fa/guide/install/", "/guide/install/"],
  );

  const absolute = translations([en, fa], { url: "https://example.com" });
  assert.deepEqual(
    hreflangLinks(absolute, en).map((link) => link.href),
    [
      "https://example.com/guide/install/",
      "https://example.com/fa/guide/install/",
      "https://example.com/guide/install/",
    ],
  );
});

test("the language prefix is stripped for grouping but kept in the href, base included", () => {
  const en = page("/docs/guide/install/");
  const fa = page("/docs/fa/guide/install/", { lang: "fa", dir: "rtl" });
  const links = hreflangLinks(translations([en, fa], { base: "/docs" }), en);

  assert.deepEqual(
    links.map((link) => link.href),
    ["/docs/guide/install/", "/docs/fa/guide/install/", "/docs/guide/install/"],
  );
});

test("a translation_key groups pages whose URLs share nothing", () => {
  const en = page("/install/", { frontMatter: { translation_key: "install" } });
  const fa = page("/fa/install-fa/", { lang: "fa", dir: "rtl", frontMatter: { translation_key: "install" } });
  const links = hreflangLinks(translations([en, fa]), fa);

  assert.deepEqual(
    links.map((link) => link.attrs?.["hreflang"]),
    ["en", "fa", "x-default"],
  );
});

test("languages are in code-point order whatever order the pages came in", () => {
  const pages = [
    page("/fa/guide/", { lang: "fa", dir: "rtl" }),
    page("/guide/", {}),
    page("/ar/guide/", { lang: "ar", dir: "rtl" }),
  ];
  const first = hreflangLinks(translations(pages), pages[1]!);
  const second = hreflangLinks(translations([...pages].reverse()), pages[1]!);

  assert.deepEqual(
    first.map((link) => link.attrs?.["hreflang"]),
    ["ar", "en", "fa", "x-default"],
  );
  assert.deepEqual(second, first);
  assert.deepEqual(hreflangLinks(translations(pages), pages[1]!), first, "two runs give the same links");
});

test("a page outside the model has no links", () => {
  const model = translations([page("/guide/"), page("/fa/guide/", { lang: "fa", dir: "rtl" })]);
  assert.deepEqual(hreflangLinks(model, page("/elsewhere/")), []);
});

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hreflang-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The `<link>` tags of a built page carrying `hreflang`. */
function linksFor(html: string, hreflang: string): string[] {
  const tags = html.match(/<link\b[^>]*>/g) ?? [];
  return tags.filter((tag) => tag.includes(`hreflang="${hreflang}"`));
}

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("a built page's head carries the alternates, and a one-language page carries none", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Example",
      "url: https://example.com",
      "lang: en",
      "languages:",
      "  - code: en",
      "    name: English",
      "    prefix: ''",
      "  - code: fa",
      "    name: فارسی",
      "    prefix: /fa",
      "",
    ].join("\n"),
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n",
    "fa/guide/install.md": "---\ntitle: نصب\n---\n# نصب\n",
    "solo.md": "---\ntitle: Solo\n---\n# Solo\n",
  });
  const parent = mkdtempSync(join(tmpdir(), "hreflang-out-"));
  const out = join(parent, "site");
  try {
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );

    const english = readFileSync(join(out, "guide/install/index.html"), "utf8");
    const persian = readFileSync(join(out, "fa/guide/install/index.html"), "utf8");
    for (const html of [english, persian]) {
      assert.equal(linksFor(html, "en").length, 1, "the English alternate is in the head");
      assert.equal(linksFor(html, "fa").length, 1, "the Persian alternate is in the head");
      assert.equal(linksFor(html, "x-default").length, 1, "x-default is in the head");
    }
    assert.match(linksFor(english, "fa")[0]!, /href="https:\/\/example\.com\/fa\/guide\/install\/"/);
    assert.match(linksFor(english, "x-default")[0]!, /href="https:\/\/example\.com\/guide\/install\/"/);
    assert.match(linksFor(persian, "en")[0]!, /href="https:\/\/example\.com\/guide\/install\/"/);

    const solo = readFileSync(join(out, "solo/index.html"), "utf8");
    assert.deepEqual(linksFor(solo, "en"), [], "a page alone in its group has no alternates");
    assert.deepEqual(linksFor(solo, "x-default"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
