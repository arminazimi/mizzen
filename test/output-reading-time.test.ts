import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import {
  countWords,
  DEFAULT_WORDS_PER_MINUTE,
  minutesFor,
  readingTime,
  readingTimeForPages,
  readingTimeOf,
} from "../src/model/facts/reading-time.ts";
import { readingTime as readingTimeOutput } from "../src/outputs/reading-time.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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
    source: { ...pos, file: `${url.replace(/^\//, "").replace(/\/$/, "") || "index"}.md` },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [] as Heading[],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the reading time never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return readingTimeOutput.run(model, ctx);
}

async function only(model: Site): Promise<OutputFile> {
  const files = await run(model);
  assert.equal(files.length, 1, "one site writes one reading-time.json");
  return files[0]!;
}

function words(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "reading-time-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the output and the fact are named reading-time", () => {
  assert.equal(readingTimeOutput.name, "reading-time");
  assert.equal(readingTime.name, "reading-time");
});

test("code blocks, inline code, images, and HTML markup are not prose", () => {
  const markdown = [
    "# Title",
    "",
    "One two `inline code` three.",
    "",
    "```js",
    "const four = 4;",
    "```",
    "",
    "~~~",
    "five six",
    "~~~",
    "",
    "    seven eight",
    "",
    "![nine ten](image.png)",
    "",
    "[eleven][ref]",
    "",
    "[ref]: https://example.com/twelve",
  ].join("\n");
  // Title, One, two, three, eleven. Code, the image alt, and the link destination are left out.
  assert.equal(countWords(markdown), 5);
});

test("HTML tags are ignored while the text a browser renders between them counts", () => {
  const markdown = [
    "Hello <span title=\"not a word\">world</span>.",
    "",
    "<div>Raw prose here</div>",
    "",
    "<!-- hidden comment words -->",
  ].join("\n");
  // Hello, world, Raw, prose, here. Attribute values and comments do not count.
  assert.equal(countWords(markdown), 5);
});

test("Latin and Cyrillic words follow Unicode boundaries", () => {
  assert.equal(countWords("One two three."), 3);
  assert.equal(countWords("don't stop"), 2);
  assert.equal(countWords("state-of-the-art"), 4);
  assert.equal(countWords("Привет мир"), 2);
  assert.equal(countWords("Hello 世界"), 3, "a Latin word plus two Han characters");
});

test("Persian and Arabic words keep the zero-width non-joiner inside a word", () => {
  assert.equal(countWords("می‌شود کتاب‌ها بزرگ‌تر"), 3);
  assert.equal(countWords("مرحبا بالعالم"), 2);
  assert.equal(countWords("می‌شود hello کتاب‌ها"), 3, "each script counts in the same paragraph");
});

test("Han, Kana, and Hangul count one word per character", () => {
  assert.equal(countWords("中文测试"), 4);
  assert.equal(countWords("日本語のテスト"), 7);
  assert.equal(countWords("한국어 테스트"), 6);
});

test("reading time is the word count divided by the rate, rounded up", () => {
  assert.equal(DEFAULT_WORDS_PER_MINUTE, 200);
  assert.equal(minutesFor(0), 0);
  assert.equal(minutesFor(1), 1);
  assert.equal(minutesFor(200), 1);
  assert.equal(minutesFor(201), 2);
  assert.equal(readingTimeOf(page("/a/", { markdown: words(150) })).minutes, 1);
  assert.equal(readingTimeOf(page("/a/", { markdown: words(150) }), { wordsPerMinute: 100 }).minutes, 2);
  assert.equal(
    readingTimeOf(page("/a/", { markdown: words(150) }), { wordsPerMinute: 0 }).minutes,
    1,
    "a non-positive rate falls back to the default",
  );
});

test("one entry per doc page records the URL, words, minutes, and source, sorted by URL", async () => {
  const file = await only(
    site([
      page("/b/", { markdown: "one two", source: { ...pos, file: "b.md" } }),
      page("/a/", { markdown: "one", source: { ...pos, file: "a.md" } }),
      page("/app/", { kind: "app", markdown: "not prose" }),
      page("/logo.svg", { kind: "asset", markdown: "not prose" }),
    ]),
  );
  const entries = JSON.parse(String(file.contents)) as unknown;
  assert.deepEqual(entries, [
    { url: "/a/", words: 1, minutes: 1, source: "a.md" },
    { url: "/b/", words: 2, minutes: 1, source: "b.md" },
  ]);
  assert.deepEqual(Object.keys((entries as Array<Record<string, unknown>>)[0]!), ["url", "words", "minutes", "source"]);
});

test("the file is reading-time.json, ends with a line feed, and two runs write the same bytes", async () => {
  const model = site([
    page("/b/", { markdown: "# B\n\ntwo words" }),
    page("/a/", { markdown: "# A\n\none word" }),
  ]);
  const first = await only(model);
  const second = await only(model);
  assert.equal(first.path, "reading-time.json");
  assert.ok(String(first.contents).endsWith("\n"), "the file ends with a line feed");
  assert.deepEqual(first.contents, second.contents);
  assert.deepEqual(
    (JSON.parse(String(first.contents)) as Array<{ url: string }>).map((entry) => entry.url),
    ["/a/", "/b/"],
  );
});

test("readingTimeForPages skips app pages and accepts a rate option", () => {
  const entries = readingTimeForPages(
    [page("/a/", { markdown: words(150) }), page("/app/", { kind: "app", markdown: words(500) })],
    { wordsPerMinute: 100 },
  );
  assert.deepEqual(entries, [{ url: "/a/", words: 150, minutes: 2, source: "a.md" }]);
});

test("a temporary site gets the fact in Site.data and the output writes the same numbers", async () => {
  const root = tree({
    "mizzen.yml": "title: Reading\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n\nOne two three.\n",
    "guide/empty.md": "---\ntitle: Empty\n---\n",
  });
  try {
    const model = await buildModel(root);
    const fact = model.site.data["reading-time"];
    assert.deepEqual(fact, [
      { url: "/guide/empty/", words: 0, minutes: 0, source: "guide/empty.md" },
      { url: "/guide/install/", words: 4, minutes: 1, source: "guide/install.md" },
    ]);

    const file = await only(model.site);
    assert.deepEqual(JSON.parse(String(file.contents)), fact);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site's _data/reading-time.yml wins and the output reuses it in a fixed shape and order", async () => {
  const root = tree({
    "mizzen.yml": "title: Reading\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n\nOne two three.\n",
    "_data/reading-time.yml": [
      "- source: custom.md",
      "  minutes: 9",
      "  words: 999",
      "  url: /z/",
      "- url: /a/",
      "  words: 7",
      "  minutes: 1",
      "  source: a.md",
    ].join("\n"),
  });
  try {
    const model = await buildModel(root);
    assert.deepEqual(model.site.data["reading-time"], [
      { source: "custom.md", minutes: 9, words: 999, url: "/z/" },
      { url: "/a/", words: 7, minutes: 1, source: "a.md" },
    ]);

    const file = await only(model.site);
    assert.deepEqual(JSON.parse(String(file.contents)), [
      { url: "/a/", words: 7, minutes: 1, source: "a.md" },
      { url: "/z/", words: 999, minutes: 9, source: "custom.md" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
