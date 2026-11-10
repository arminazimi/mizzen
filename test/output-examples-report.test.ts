import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import { build } from "../src/pipeline/build.ts";
import {
  examplesCacheDir,
  examplesReport,
  examplesReportOutput,
  type ExampleRunInput,
  type ExampleRunner,
  type ExamplesReportOptions,
} from "../src/outputs/examples-report.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const POS = { file: "guide/examples.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

/** One doc page whose body starts on line 1, so fence positions are the Markdown's own lines. */
function page(url: string, markdown: string): Page {
  return {
    url,
    source: POS,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  return { config: config(), pages, nav: {}, data: {} };
}

/** The single `examples.json` file the report writes. */
async function reportOf(model: Site, options: ExamplesReportOptions = {}): Promise<OutputFile> {
  const files = await examplesReport(model, options);
  assert.equal(files.length, 1, "the report writes one file");
  return files[0]!;
}

function bodyOf(file: OutputFile): { pages: Array<Record<string, unknown>> } {
  return JSON.parse(String(file.contents)) as { pages: Array<Record<string, unknown>> };
}

/** A runner that answers by the code it is given. */
function runnerFor(answers: Readonly<Record<string, { exitCode: number | null; stdout: string }>>): ExampleRunner {
  return async (input) => {
    const answer = answers[input.code];
    assert.ok(answer, `the test runner has an answer for ${JSON.stringify(input.code)}`);
    return answer;
  };
}

const TWO_EXAMPLES = [
  "# Examples", // 1
  "", // 2
  "```ts test", // 3
  'console.log("pass");',
  "```",
  "```output", // 6
  "pass",
  "```",
  "", // 9
  "```ts test", // 10
  'console.log("actual");',
  "```",
  "```output", // 13
  "expected",
  "```",
  "", // 16
].join("\n");

test("the output is named after its file", () => {
  assert.equal(examplesReportOutput.name, "examples-report");
});

test("pass and fail counts cover every example, and a failure carries the fence's position", async () => {
  const diagnostics: Diagnostic[] = [];
  const model = site([page("/examples/", TWO_EXAMPLES)]);
  const file = await reportOf(model, {
    runner: runnerFor({
      'console.log("pass");': { exitCode: 0, stdout: "pass\n" },
      'console.log("actual");': { exitCode: 0, stdout: "actual\n" },
    }),
    report: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(bodyOf(file), {
    pages: [{ url: "/examples/", total: 2, passed: 1, failed: 1, skipped: 0 }],
  });

  assert.equal(diagnostics.length, 1, "only the failing example is reported");
  const [failure] = diagnostics;
  assert.equal(failure?.id, "example-failed");
  assert.deepEqual(failure?.pos, {
    file: "guide/examples.md",
    line: 10,
    column: 1,
    endLine: 12,
    endColumn: 3,
  });
  assert.match(failure?.message ?? "", /\/examples\//);
  assert.match(failure?.message ?? "", /expected "expected" but got "actual/);
});

test("a page without examples is present with zero counts", async () => {
  const file = await reportOf(site([page("/empty/", "# Empty\n")]), {
    runner: () => Promise.reject(new Error("no example may run")),
  });
  assert.deepEqual(bodyOf(file), {
    pages: [{ url: "/empty/", total: 0, passed: 0, failed: 0, skipped: 0 }],
  });
});

test("an app page is present with zero counts and its body is never parsed for examples", async () => {
  const app: Page = {
    ...page("/dashboard/", '```ts test\nconsole.log("never");\n```\n'),
    kind: "app",
  };
  const file = await reportOf(site([app]), {
    runner: () => Promise.reject(new Error("an app page's body is not run")),
  });
  assert.deepEqual(bodyOf(file), {
    pages: [{ url: "/dashboard/", total: 0, passed: 0, failed: 0, skipped: 0 }],
  });
});

test("an unsupported language is counted as skipped, not failed, and is never run", async () => {
  const markdown = ["```python test", 'print("hi")', "```", "```output", "hi", "```", ""].join("\n");
  const calls: ExampleRunInput[] = [];
  const diagnostics: Diagnostic[] = [];
  const file = await reportOf(site([page("/python/", markdown)]), {
    runner: (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stdout: "hi\n" });
    },
    report: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(calls, [], "no runner handles python");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(bodyOf(file), {
    pages: [{ url: "/python/", total: 1, passed: 0, failed: 0, skipped: 1 }],
  });
});

test("pages are sorted by URL and the bytes are fixed: key order, two spaces, LF, no time or duration", async () => {
  const model = site([page("/b/", "# B\n"), page("/a/", "# A\n"), page("/c/", "# C\n")]);
  const first = await reportOf(model, { runner: () => Promise.reject(new Error("no example may run")) });
  const second = await reportOf(model, { runner: () => Promise.reject(new Error("no example may run")) });

  assert.equal(first.contents, second.contents, "two runs write the same bytes");
  assert.equal(
    String(first.contents),
    [
      "{",
      '  "pages": [',
      "    {",
      '      "url": "/a/",',
      '      "total": 0,',
      '      "passed": 0,',
      '      "failed": 0,',
      '      "skipped": 0',
      "    },",
      "    {",
      '      "url": "/b/",',
      '      "total": 0,',
      '      "passed": 0,',
      '      "failed": 0,',
      '      "skipped": 0',
      "    },",
      "    {",
      '      "url": "/c/",',
      '      "total": 0,',
      '      "passed": 0,',
      '      "failed": 0,',
      '      "skipped": 0',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(String(first.contents), /duration|time|date|generated/i);
});

test("the cache runs an identical example once across pages and invocations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "examples-report-cache-"));
  let runs = 0;
  const runner: ExampleRunner = () => {
    runs += 1;
    return Promise.resolve({ exitCode: 0, stdout: "once\n" });
  };
  const markdown = ["```js test", 'console.log("once");', "```", "```output", "once", "```", ""].join("\n");
  const model = site([page("/one/", markdown), page("/two/", markdown)]);

  try {
    const first = await reportOf(model, { runner, cacheDir: dir });
    assert.equal(runs, 1, "the second page read the first page's result from the cache");
    assert.deepEqual(bodyOf(first), {
      pages: [
        { url: "/one/", total: 1, passed: 1, failed: 0, skipped: 0 },
        { url: "/two/", total: 1, passed: 1, failed: 0, skipped: 0 },
      ],
    });

    const second = await reportOf(model, { runner, cacheDir: dir });
    assert.equal(runs, 1, "a second report reused the stored results");
    assert.equal(second.contents, first.contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default runner runs a js example and a sh example", async () => {
  const markdown = [
    "```js test",
    'console.log("js");',
    "```",
    "```output",
    "js",
    "```",
    "",
    "```sh test",
    "echo sh",
    "```",
    "```output",
    "sh",
    "```",
    "",
  ].join("\n");
  const file = await reportOf(site([page("/real/", markdown)]));
  assert.deepEqual(bodyOf(file), {
    pages: [{ url: "/real/", total: 2, passed: 2, failed: 0, skipped: 0 }],
  });
});

test("the cache is enabled only when MIZZEN_EXAMPLES_CACHE is set, and 1 means .mizzen/examples", () => {
  assert.equal(examplesCacheDir({}), undefined);
  assert.equal(examplesCacheDir({ MIZZEN_EXAMPLES_CACHE: "/tmp/example-cache" }), "/tmp/example-cache");
  assert.equal(examplesCacheDir({ MIZZEN_EXAMPLES_CACHE: "  " }), join(process.cwd(), ".mizzen", "examples"));
  assert.equal(examplesCacheDir({ MIZZEN_EXAMPLES_CACHE: "1" }), join(process.cwd(), ".mizzen", "examples"));
  assert.equal(examplesCacheDir({ MIZZEN_EXAMPLES_CACHE: "TRUE" }), join(process.cwd(), ".mizzen", "examples"));
});

/** A temporary site tree. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "examples-report-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A fresh output folder whose parent the caller removes. */
function outFolder(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "examples-report-out-"));
  return { parent, out: join(parent, "site") };
}

test("the output runs by default and outputs: { examples-report: false } switches it off", async () => {
  const onRoot = tree({ "a.md": "---\ntitle: A\n---\n# A\n" });
  const offRoot = tree({
    "mizzen.yml": "outputs:\n  examples-report: false\n",
    "a.md": "---\ntitle: A\n---\n# A\n",
  });
  const on = outFolder();
  const off = outFolder();
  try {
    const built = await build({ root: onRoot, out: on.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.ok(built.files.includes("examples.json"), "the output is on by default");
    assert.deepEqual(
      JSON.parse(readFileSync(join(on.out, "examples.json"), "utf8")) as { pages: unknown },
      { pages: [{ url: "/a/", total: 0, passed: 0, failed: 0, skipped: 0 }] },
    );

    const switched = await build({ root: offRoot, out: off.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.equal(switched.files.includes("examples.json"), false, "the switched-off output writes nothing");
    assert.equal(existsSync(join(off.out, "examples.json")), false);
  } finally {
    rmSync(onRoot, { recursive: true, force: true });
    rmSync(offRoot, { recursive: true, force: true });
    rmSync(on.parent, { recursive: true, force: true });
    rmSync(off.parent, { recursive: true, force: true });
  }
});
