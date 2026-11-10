import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Diagnostic, Page, SearchConfig, Site } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { search } from "../src/outputs/search.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function site(pages: readonly Page[], config: false | SearchConfig = {}): Site {
  return {
    config: {
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
      search: config,
      redirects: {},
      outputs: {},
    },
    pages,
    nav: {},
    data: {},
  };
}

function page(url: string, options: { title?: string; lang?: string; html?: string; search?: boolean } = {}): Page {
  const title = options.title ?? url;
  return {
    url,
    source: pos,
    frontMatter: options.search === false ? { search: false } : {},
    title,
    lang: options.lang ?? "en",
    dir: options.lang === "fa" ? "rtl" : "ltr",
    headings: [],
    html: options.html ?? `<h1>${title}</h1><p>Reports when a rule is missing.</p>`,
    markdown: "",
    kind: "doc",
  };
}

/** An output context that records diagnostics; the search output must not render pages a second time. */
function context(reports: Diagnostic[] = []): OutputContext {
  return {
    renderPage: () => Promise.reject(new Error("the search output must not render pages")),
    report: (d) => {
      reports.push(d);
    },
  };
}

/** Writes the output's files under a temporary folder, so Pagefind's runtime can be imported from it. */
async function writeFiles(files: readonly OutputFile[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mizzen-search-"));
  for (const file of files) {
    const abs = join(dir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents);
  }
  return dir;
}

interface SearchResult {
  results: readonly { data(): Promise<{ url: string; meta: Record<string, string>; filters: Record<string, string[]> }> }[];
}

/** The generated search runtime, as much of it as the tests use. */
interface Runtime {
  options(options: { basePath?: string }): Promise<void>;
  init(): Promise<void>;
  search(term: string, options?: { filters?: Record<string, string> }): Promise<SearchResult>;
}

/**
 * Loads the generated `pagefind.js` in Node. Pagefind's runtime fetches the index, which Node's `fetch` refuses for
 * `file:` URLs and for a site path, so the test answers those requests from the temporary folder and restores the
 * real fetch afterwards. The base path is `/pagefind/`, as on a published site, so result URLs stay site-relative.
 */
async function loadRuntime(dir: string): Promise<{ runtime: Runtime; restore: () => void }> {
  const original = globalThis.fetch;
  const runtimeBase = "/pagefind/";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string") {
      const url = new URL(input, pathToFileURL(`${dir}/`));
      if (url.pathname.startsWith(runtimeBase)) {
        return new Response(await readFile(join(dir, "pagefind", decodeURIComponent(url.pathname.slice(runtimeBase.length)))));
      }
      if (url.protocol === "file:") return new Response(await readFile(fileURLToPath(url)));
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const runtime = (await import(pathToFileURL(join(dir, "pagefind", "pagefind.js")).href)) as Runtime;
    await runtime.options({ basePath: runtimeBase });
    await runtime.init();
    return { runtime, restore: () => (globalThis.fetch = original) };
  } catch (error) {
    globalThis.fetch = original;
    throw error;
  }
}

/** The parsed `pagefind-entry.json`, which names every language index and its page count. */
async function entryOf(dir: string): Promise<{ languages: Record<string, { page_count: number }> }> {
  const raw = await readFile(join(dir, "pagefind", "pagefind-entry.json"), "utf8");
  return JSON.parse(raw) as { languages: Record<string, { page_count: number }> };
}

test("a query for a rule title returns that rule page first on fixtures/docs-site", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const reports: Diagnostic[] = [];
  const files = await search.run(model, context(reports));
  assert.deepEqual(reports, []);

  const dir = await writeFiles(files);
  const { runtime, restore } = await loadRuntime(dir);
  try {
    const found = await runtime.search("hooks-033");
    assert.ok(found.results.length > 0, "the rule is indexed");
    const first = await found.results[0]!.data();
    assert.equal(first.url, "/rules/hooks-033/", "the rule page ranks first");
    assert.equal(first.meta.title, "Rule hooks-033", "the page title is the result's title");

    const rules = await runtime.search("rule", { filters: { section: "rules" } });
    assert.ok(rules.results.length > 0, "the section filter matches rule pages");
    for (const result of rules.results) {
      const data = await result.data();
      assert.deepEqual(data.filters.section, ["rules"], `${data.url} is in the rules section`);
    }

    const other = await runtime.search("hooks-033", { filters: { section: "guide" } });
    assert.equal(other.results.length, 0, "another section filters the rule out");
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("search: false in the site config writes no index", async () => {
  const files = await search.run(site([page("/rules/a/")], false), context());
  assert.deepEqual(files, []);
});

test("a page with search: false in its front matter is left out", async () => {
  const model = site([
    page("/rules/included/", { title: "Included rule" }),
    page("/rules/excluded/", { title: "Excluded rule", search: false }),
  ]);
  const files = await search.run(model, context());
  const dir = await writeFiles(files);
  try {
    const entry = await entryOf(dir);
    assert.equal(entry.languages.en?.page_count, 1, "only the included page is indexed");
    const { runtime, restore } = await loadRuntime(dir);
    try {
      const found = await runtime.search("Excluded");
      assert.equal(found.results.length, 0, "the excluded page is not searchable");
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexes the model's article body without rendering the page a second time", async () => {
  let renders = 0;
  const ctx: OutputContext = {
    renderPage: () => {
      renders += 1;
      return Promise.resolve("<html><body><nav>Chrome-only sentinel</nav></body></html>");
    },
    report: () => {},
  };
  const files = await search.run(
    site([page("/rules/a/", { title: "Rule A", html: "<h1>Rule A</h1><p>Article body sentinel</p>" })]),
    ctx,
  );
  assert.equal(renders, 0, "the page is not rendered again, so layout diagnostics are not repeated");
  const dir = await writeFiles(files);
  const { runtime, restore } = await loadRuntime(dir);
  try {
    assert.equal((await runtime.search("sentinel")).results.length, 1, "the article body is indexed");
    assert.equal((await runtime.search("Chrome")).results.length, 0, "the chrome is not in the index");
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Persian page is indexed in its own language", async () => {
  const model = site([
    page("/guide/install/", { title: "Install", lang: "en" }),
    page("/fa/guide/install/", { title: "نصب", lang: "fa" }),
  ]);
  const files = await search.run(model, context());
  const dir = await writeFiles(files);
  try {
    const entry = await entryOf(dir);
    assert.deepEqual(Object.keys(entry.languages).sort(), ["en", "fa"], "one index per language");
    assert.equal(entry.languages.fa?.page_count, 1, "the fa page is in the fa index");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the index for 600 pages is under 1 MB before compression", async () => {
  const pages = Array.from({ length: 600 }, (_, i) =>
    page(`/rules/rule-${i}/`, {
      title: `Rule ${i}`,
      html: `<h1>Rule ${i}</h1><p>Reports when a rule is missing. Change the configuration so the rule passes, then run the doctor again.</p>`,
    }),
  );
  const files = await search.run(site(pages), context());
  const bytes = files.reduce(
    (total, file) => total + (typeof file.contents === "string" ? Buffer.byteLength(file.contents) : file.contents.length),
    0,
  );
  assert.ok(bytes < 1_000_000, `the index is ${bytes} bytes for 600 pages`);
});
