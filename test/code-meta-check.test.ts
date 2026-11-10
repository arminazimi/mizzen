import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { codeMetaCheck, invalidCodeMeta } from "../src/outputs/code-meta-check.ts";

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

/** A document page whose Markdown body starts at `bodyLine`. */
function page(file: string, markdown: string, bodyLine = 1): Page {
  return {
    url: `/${file.replace(/\.md$/, "/")}`,
    source: { file, line: bodyLine, column: 1, endLine: bodyLine, endColumn: 1 },
    frontMatter: {},
    title: file,
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

/** A context that keeps every diagnostic, so a test can check what the output reported. */
function collecting(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the code meta check never renders a page")),
    report: (d) => reported.push(d),
  };
  return { ctx, reported };
}

test("valid line lists report nothing, including spaces, ins, del, and diff", () => {
  assert.deepEqual(invalidCodeMeta("```ts {1,2-3} ins={1} del={2} diff\none\ntwo\nthree\n```\n", "guide/install.md"), []);
  assert.deepEqual(invalidCodeMeta("```ts { 1 , 3 - 3 }\none\ntwo\nthree\n```\n", "guide/install.md"), []);
  assert.deepEqual(invalidCodeMeta('```ts ins="" del={}\none\n```\n', "guide/install.md"), []);
});

test("fences without meta, or with meta that names no lines, report nothing", () => {
  assert.deepEqual(invalidCodeMeta("```bash\nnpm ci\n```\n", "guide/install.md"), []);
  assert.deepEqual(invalidCodeMeta('```bash title="install"\nnpm ci\n```\n', "guide/install.md"), []);
});

test("0, a descending range, a non-number, and a line past the fence each report once", () => {
  const found = invalidCodeMeta("```ts {0,5-3,x,9}\none\ntwo\n```\n", "guide/install.md");
  assert.deepEqual(
    found.map((d) => [d.id, d.severity, d.message]),
    [
      ["code.invalid-meta", "warning", '"0" in the highlighted lines starts before line 1.'],
      ["code.invalid-meta", "warning", '"5-3" in the highlighted lines ends before it starts.'],
      ["code.invalid-meta", "warning", '"x" in the highlighted lines is not a line or a range.'],
      ["code.invalid-meta", "warning", '"9" in the highlighted lines is past the block\'s last line (2).'],
    ],
  );
});

test("ins and del name their own lists, and an empty fence has no lines to point at", () => {
  const found = invalidCodeMeta("```ts ins={0} del={x}\na\n```\n\n```ts {1}\n```\n", "guide/install.md");
  assert.deepEqual(
    found.map((d) => d.message),
    [
      '"0" in the inserted lines starts before line 1.',
      '"x" in the deleted lines is not a line or a range.',
      '"1" in the highlighted lines is past the block\'s last line (0).',
    ],
  );
});

test("each finding carries the fence's source span, shifted by the front matter", () => {
  const markdown = "intro\n\n```ts {0}\none\n```\n";
  const [found] = invalidCodeMeta(markdown, "docs/page.md", 5);
  assert.ok(found);
  assert.deepEqual(found.pos, {
    file: "docs/page.md",
    line: 7,
    column: 1,
    endLine: 9,
    endColumn: 3,
  });
});

test("findings come in document order, and the same Markdown always gives the same list", () => {
  const markdown = ["```ts {0}", "a", "```", "", "```ts ins={5} {x}", "a", "b", "```", ""].join("\n");
  const first = invalidCodeMeta(markdown, "guide/install.md");
  const second = invalidCodeMeta(markdown, "guide/install.md");
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((d) => `${d.pos?.line}:${d.message}`),
    [
      '1:"0" in the highlighted lines starts before line 1.',
      '5:"5" in the inserted lines is past the block\'s last line (2).',
      '5:"x" in the highlighted lines is not a line or a range.',
    ],
  );
});

test("the output writes no files and reports pages in model order", async () => {
  const { ctx, reported } = collecting();
  const files = await codeMetaCheck.run(
    site([page("a.md", "```ts {0}\none\n```\n"), page("b.md", "```ts {9}\none\n```\n")]),
    ctx,
  );
  assert.deepEqual(files, []);
  assert.deepEqual(
    reported.map((d) => d.pos?.file),
    ["a.md", "b.md"],
  );
});

test("the output reports nothing for a site whose fences are valid", async () => {
  const { ctx, reported } = collecting();
  await codeMetaCheck.run(site([page("a.md", "```ts {1} diff\none\n```\n")]), ctx);
  assert.deepEqual(reported, []);
});
