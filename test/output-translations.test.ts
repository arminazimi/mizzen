import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { translations, translationsFile, type TranslationRecord } from "../src/outputs/translations.ts";

const pos = { file: "test/no-such-translations-source/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}, data: Record<string, unknown> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data };
}

/** The output reads no render host and reports nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the translations output never renders a page")),
  report: () => {},
};

const LANGUAGES = [
  { code: "de", name: "Deutsch", prefix: "/de" },
  { code: "en", name: "English", prefix: "" },
  { code: "fa", name: "فارسی", prefix: "/fa" },
] as const;

async function run(model: Site, root?: string): Promise<readonly OutputFile[]> {
  return root === undefined ? translations.run(model, ctx) : translationsFile(model, root);
}

async function only(model: Site, root?: string): Promise<readonly TranslationRecord[]> {
  const files = await run(model, root);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "translations.json");
  return JSON.parse(String(files[0]?.contents)) as TranslationRecord[];
}

const hasGit = !spawnSync("git", ["--version"]).error;

/** A temporary git repository with `files` committed at the given committer dates; the caller removes it. */
function repository(files: readonly { readonly path: string; readonly date: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "translations-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Translations Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "translations@example.com"], { cwd: root });
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${file.path}\n`);
    execFileSync("git", ["add", "--", file.path], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", file.path], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: file.date, GIT_COMMITTER_DATE: file.date },
    });
  }
  return root;
}

test("the output is named after its file and writes translations.json", async () => {
  assert.equal(translations.name, "translations");
  const model = site([page("/guide/")], { languages: [{ code: "en", name: "English", prefix: "" }] });
  const files = await run(model);
  assert.deepEqual(
    files.map((file) => file.path),
    ["translations.json"],
  );
});

test("each configured language is translated, a fallback, or missing, sorted by URL then language", async () => {
  const pages = [
    page("/guide/only/", { lang: "en" }),
    page("/fa/guide/solo/", { lang: "fa" }),
    page("/fa/guide/install/", { lang: "fa" }),
    page("/guide/install/", { lang: "en" }),
  ];
  const model = site(pages, { languages: LANGUAGES });

  assert.deepEqual(await only(model), [
    { url: "/fa/guide/solo/", lang: "de", status: "missing" },
    { url: "/fa/guide/solo/", lang: "en", status: "missing" },
    { url: "/fa/guide/solo/", lang: "fa", status: "translated" },
    { url: "/guide/install/", lang: "de", status: "fallback" },
    { url: "/guide/install/", lang: "en", status: "translated" },
    { url: "/guide/install/", lang: "fa", status: "translated" },
    { url: "/guide/only/", lang: "de", status: "fallback" },
    { url: "/guide/only/", lang: "en", status: "translated" },
    { url: "/guide/only/", lang: "fa", status: "fallback" },
  ]);
});

test("a fallback chain from _data/languages.yml decides the source page and the stand-ins", async () => {
  const model = site(
    [page("/guide/install/", { lang: "en" }), page("/fa/guide/install/", { lang: "fa" })],
    { languages: LANGUAGES },
    { languages: { fallback: ["fa"] } },
  );

  // fa is the source, so the records are written from its URL and en is the fallback for the other languages.
  assert.deepEqual(await only(model), [
    { url: "/fa/guide/install/", lang: "de", status: "fallback" },
    { url: "/fa/guide/install/", lang: "en", status: "translated" },
    { url: "/fa/guide/install/", lang: "fa", status: "translated" },
  ]);
});

test("a site with one language writes one record per page, and no configured language writes no file", async () => {
  const single = site(
    [page("/a/"), page("/b/")],
    { languages: [{ code: "en", name: "English", prefix: "" }] },
  );
  assert.deepEqual(await only(single), [
    { url: "/a/", lang: "en", status: "translated" },
    { url: "/b/", lang: "en", status: "translated" },
  ]);

  // No `languages` means no translations to report: the output writes nothing, so its empty shape is "no file".
  assert.deepEqual(await run(site([page("/a/"), page("/b/")])), []);
  assert.deepEqual(await run(site([])), []);
});

test("the bytes are deterministic whatever order the pages arrive in", async () => {
  const pages = [
    page("/guide/install/", { lang: "en" }),
    page("/fa/guide/install/", { lang: "fa" }),
    page("/guide/only/", { lang: "en" }),
  ];
  const forward = await run(site(pages, { languages: LANGUAGES }));
  const backward = await run(site([...pages].reverse(), { languages: LANGUAGES }));

  assert.equal(String(forward[0]?.contents), String(backward[0]?.contents));
  const text = String(forward[0]?.contents);
  assert.ok(text.endsWith("}\n]\n") || text.endsWith("]\n"), "two-space JSON with a trailing LF and no CR");
  assert.ok(!text.includes("\r"));
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
});

test(
  "a translation older than its source is stale, and git dates win over front matter",
  { skip: hasGit ? false : "git is not installed" },
  async () => {
    const root = repository([
      { path: "guide/install.md", date: "2026-10-01T10:00:00Z" },
      { path: "fa/guide/install.md", date: "2026-09-01T10:00:00Z" },
      { path: "guide/fresh.md", date: "2026-09-01T10:00:00Z" },
      { path: "fa/guide/fresh.md", date: "2026-10-01T10:00:00Z" },
      { path: "guide/equal.md", date: "2026-09-01T10:00:00Z" },
      { path: "fa/guide/equal.md", date: "2026-09-01T10:00:00Z" },
    ]);
    try {
      const model = site(
        [
          // The front matter says the opposite; the git dates must decide.
          page("/guide/install/", {
            lang: "en",
            source: { ...pos, file: "guide/install.md" },
            frontMatter: { last_modified_at: "2020-01-01" },
          }),
          page("/fa/guide/install/", {
            lang: "fa",
            source: { ...pos, file: "fa/guide/install.md" },
            frontMatter: { last_modified_at: "2026-09-15" },
          }),
          page("/guide/fresh/", { lang: "en", source: { ...pos, file: "guide/fresh.md" } }),
          page("/fa/guide/fresh/", { lang: "fa", source: { ...pos, file: "fa/guide/fresh.md" } }),
          page("/guide/equal/", { lang: "en", source: { ...pos, file: "guide/equal.md" } }),
          page("/fa/guide/equal/", { lang: "fa", source: { ...pos, file: "fa/guide/equal.md" } }),
          // No Git history for these files: the front matter dates are the fallback.
          page("/guide/untracked/", { lang: "en", frontMatter: { last_modified_at: "2026-10-01" } }),
          page("/fa/guide/untracked/", { lang: "fa", frontMatter: { last_modified_at: "2026-09-01" } }),
        ],
        { languages: LANGUAGES },
      );

      const records = await only(model, root);
      const status = (url: string, lang: string): string | undefined =>
        records.find((record) => record.url === url && record.lang === lang)?.status;

      assert.equal(status("/guide/install/", "fa"), "stale", "the git date is older than the source's");
      assert.equal(status("/guide/fresh/", "fa"), "translated", "newer than the source is not stale");
      assert.equal(status("/guide/equal/", "fa"), "translated", "the same date is not stale");
      assert.equal(status("/guide/untracked/", "fa"), "stale", "front matter dates are the fallback");
      // No configured German page falls back to en, exactly as N37 resolves it.
      assert.equal(status("/guide/install/", "de"), "fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
