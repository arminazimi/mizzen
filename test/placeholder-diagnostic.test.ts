import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Heading, Page, Site } from "../src/contracts/index.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";
import {
  placeholderDiagnostics,
  UNDEFINED_PLACEHOLDER,
  undefinedPlaceholders,
} from "../src/pipeline/placeholder-diagnostic.ts";

const FILE = "guide/install.md";

/** A site config with the defaults a build fills in. */
function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
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
      search: {},
      redirects: {},
      outputs: {},
    },
    pages,
    nav: {},
    data,
  };
}

/** A Markdown page whose body starts at `bodyLine` in `file`. */
function page(url: string, markdown: string, bodyLine = 1, kind: Page["kind"] = "doc"): Page {
  return {
    url,
    source: { file: FILE, line: bodyLine, column: 1, endLine: bodyLine, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [] as Heading[],
    html: "",
    markdown,
    kind,
  };
}

/** The placeholder names a diagnostic list reports, in order. */
function names(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => /\{\{([^}]+)\}\}/.exec(diagnostic.message)?.[1] ?? "");
}

test("the undefined-placeholder code is stable", () => {
  assert.equal(UNDEFINED_PLACEHOLDER, "placeholder.undefined");
});

test("an undefined placeholder is reported once with its source span", async () => {
  const found = await placeholderDiagnostics(site([page("/guide/install/", "Run `{{api_key}}` now.\n", 7)]));

  assert.deepEqual(found, [
    {
      id: "placeholder.undefined",
      severity: "warning",
      message: 'Placeholder "{{api_key}}" has no declared variable.',
      pos: { file: FILE, line: 7, column: 6, endLine: 7, endColumn: 16 },
      help: 'Declare "api_key" in `_data/variables.yml`, or escape it as `\\{{api_key}}` to keep it literal.',
    },
  ]);
});

test("a declared variable produces no diagnostic", async () => {
  const model = site([page("/guide/", "Set `{{api_key}}` and `{{project}}`.\n")], {
    variables: [
      { name: "api_key", default: "YOUR_KEY", type: "string" },
      { name: "project", default: "my-app" },
    ],
  });

  assert.deepEqual(await placeholderDiagnostics(model), []);
});

test("multiple placeholders are reported in source order", async () => {
  const markdown = "Run `{{a}}` then `{{b}}`.\n\n```sh\necho {{c}}\n```\n";
  const found = await placeholderDiagnostics(site([page("/guide/", markdown)]));

  assert.deepEqual(names(found), ["a", "b", "c"]);
  assert.deepEqual(
    found.map((diagnostic) => [diagnostic.pos?.line, diagnostic.pos?.column]),
    [
      [1, 6],
      [1, 19],
      [4, 6],
    ],
  );
});

test("a declaration for one name leaves the other placeholders reported", async () => {
  const model = site([page("/guide/", "`{{known}}` and `{{unknown}}`.\n")], {
    variables: [{ name: "known" }],
  });

  const found = await placeholderDiagnostics(model);
  assert.deepEqual(names(found), ["unknown"]);
  assert.equal(found.length, 1);
});

test("a page with no placeholder produces no diagnostic", async () => {
  assert.deepEqual(await placeholderDiagnostics(site([page("/guide/", "Plain prose, no code.\n")])), []);
});

test("an escaped placeholder is literal and produces no diagnostic", async () => {
  const markdown = "Write `\\{{literal}}` as is.\n";
  assert.deepEqual(await placeholderDiagnostics(site([page("/guide/", markdown)])), []);
});

test("placeholders outside code are prose and produce no diagnostic", async () => {
  const markdown = "Prose may mention {{api_key}} without it being a variable.\n";
  assert.deepEqual(await placeholderDiagnostics(site([page("/guide/", markdown)])), []);
});

test("app and asset pages are not inspected", async () => {
  const pageWithPlaceholder = page("/app/", "Run `{{api_key}}`.\n");
  assert.deepEqual(
    await placeholderDiagnostics(site([{ ...pageWithPlaceholder, kind: "app" }])),
    [],
  );
  assert.deepEqual(
    await placeholderDiagnostics(site([{ ...pageWithPlaceholder, kind: "asset" }])),
    [],
  );
});

test("pages are reported in URL order, independent of input order", async () => {
  const b = page("/b/", "Use `{{b_var}}`.\n");
  const a = page("/a/", "Use `{{a_var}}`.\n");

  const forward = await undefinedPlaceholders([a, b], new Set());
  const backward = await undefinedPlaceholders([b, a], new Set());
  assert.deepEqual(names(forward), ["a_var", "b_var"]);
  assert.deepEqual(forward, backward);
});

test("reporting changes no page and no rendered HTML", async () => {
  const source = "Set `{{api_key}}` first.\n";
  const model = site([page("/guide/", source)]);
  const before = await markdownToHtml(await parseMarkdown(source), FILE);
  const found = await placeholderDiagnostics(model);

  assert.equal(found.length, 1);
  assert.equal(model.pages[0]?.markdown, source, "the page body is not rewritten");
  const after = await markdownToHtml(await parseMarkdown(model.pages[0]!.markdown), FILE);
  assert.equal(after.html, before.html, "rendering is unchanged");
});
