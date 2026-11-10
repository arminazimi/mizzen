import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import {
  declarationsOf,
  usedVariables,
  variables,
  variablesOf,
  type VariableDeclaration,
} from "../src/outputs/variables.ts";

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

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
  return { config: config(), pages, nav: {}, data };
}

interface Run {
  readonly files: readonly OutputFile[];
  readonly diagnostics: readonly Diagnostic[];
}

async function run(model: Site): Promise<Run> {
  const diagnostics: Diagnostic[] = [];
  const files = await variables.run(model, {
    renderPage: () => Promise.reject(new Error("the variables output never renders a page")),
    report: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { files, diagnostics };
}

async function only(model: Site): Promise<{ file: OutputFile; diagnostics: readonly Diagnostic[] }> {
  const { files, diagnostics } = await run(model);
  assert.equal(files.length, 1, "one site with variables writes one variables.json");
  return { file: files[0]!, diagnostics };
}

function body(file: OutputFile): Array<Record<string, unknown>> {
  return JSON.parse(String(file.contents)) as Array<Record<string, unknown>>;
}

test("the output is named after its file", () => {
  assert.equal(variables.name, "variables");
});

test("a name a page uses with no declaration is listed with a null default and an unknown type", async () => {
  const { file, diagnostics } = await only(site([page("/guide/install/", { markdown: "Run `{{api_key}}` now.\n" })]));

  assert.equal(file.path, "variables.json");
  const entries = body(file);
  assert.deepEqual(entries, [{ name: "api_key", default: null, type: "unknown", pages: ["/guide/install/"] }]);
  assert.deepEqual(Object.keys(entries[0]!), ["name", "default", "type", "pages"], "the key order is fixed");
  assert.deepEqual(diagnostics, [], "an undeclared name is not a problem");
});

test("an inline span and a fenced block both count, and an escaped placeholder does not", async () => {
  const markdown = "Set `{{api_key}}` first.\n\n```sh\necho {{host}}\n```\n\nWrite `\\{{literal}}` as is.\n";
  const { file } = await only(site([page("/guide/", { markdown })]));
  assert.deepEqual(
    body(file).map((entry) => entry.name),
    ["api_key", "host"],
  );
});

test("a declaration gives the default and the type", async () => {
  const { file } = await only(
    site([page("/guide/", { markdown: "Set `{{api_key}}`.\n" })], {
      variables: [{ name: "api_key", default: "YOUR_KEY", type: "string" }],
    }),
  );
  assert.deepEqual(body(file), [
    { name: "api_key", default: "YOUR_KEY", type: "string", pages: ["/guide/"] },
  ]);
});

test("a declaration without a default keeps the key out, and an explicit null default stays null", async () => {
  const { file } = await only(
    site([page("/guide/", { markdown: "Set `{{one}}` and `{{two}}`.\n" })], {
      variables: [
        { name: "one", type: "string" },
        { name: "two", default: null, type: "string" },
      ],
    }),
  );
  const entries = body(file);
  assert.deepEqual(Object.keys(entries[0]!), ["name", "type", "pages"], "no default key when none is declared");
  assert.equal(entries[1]!.default, null, "an explicit null is a declared default");
});

test("a name used on several pages lists each URL once and sorts them by code point", async () => {
  const { file } = await only(
    site([
      page("/b/", { markdown: "`{{api_key}}` and `{{api_key}}` and `{{project}}`.\n" }),
      page("/a/", { markdown: "`{{api_key}}`.\n" }),
    ]),
  );
  const entries = body(file);
  assert.deepEqual(entries, [
    { name: "api_key", default: null, type: "unknown", pages: ["/a/", "/b/"] },
    { name: "project", default: null, type: "unknown", pages: ["/b/"] },
  ]);
});

test("a variable declared but used by no page is listed with an empty page list", async () => {
  const { file } = await only(
    site([page("/guide/", { markdown: "No code here.\n" })], {
      variables: [{ name: "api_key", default: "YOUR_KEY", type: "string" }],
    }),
  );
  assert.deepEqual(body(file), [{ name: "api_key", default: "YOUR_KEY", type: "string", pages: [] }]);
});

test("a name declared twice with different defaults is one entry, the first value, and a diagnostic", async () => {
  const { file, diagnostics } = await only(
    site([page("/guide/", { markdown: "Set `{{api_key}}`.\n" })], {
      variables: [
        { name: "api_key", default: "first", type: "string" },
        { name: "api_key", default: "second", type: "string" },
      ],
    }),
  );

  assert.deepEqual(body(file), [
    { name: "api_key", default: "first", type: "string", pages: ["/guide/"] },
  ]);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic?.id, "variables.conflict");
  assert.equal(diagnostic?.severity, "error");
  assert.match(diagnostic?.message ?? "", /api_key/);
  assert.deepEqual(
    diagnostic?.pos,
    { file: "_data/variables.yml", line: 1, column: 1, endLine: 1, endColumn: 1 },
    "the diagnostic names the declarations file",
  );
});

test("a conflict in the type alone is reported, and conflicts are sorted by name", async () => {
  const { diagnostics } = await only(
    site(
      [
        page("/guide/", { markdown: "`{{b}}` and `{{a}}`.\n" }),
      ],
      {
        variables: [
          { name: "b", type: "string" },
          { name: "b", type: "number" },
          { name: "a", default: 1 },
          { name: "a", default: 2 },
        ],
      },
    ),
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'The variable "a" is declared more than once with different defaults or types.',
      'The variable "b" is declared more than once with different defaults or types.',
    ],
  );
});

test("identical duplicates and complementary declarations are not conflicts", async () => {
  const { file, diagnostics } = await only(
    site([page("/guide/", { markdown: "Set `{{api_key}}`.\n" })], {
      variables: [
        { name: "api_key", default: "YOUR_KEY" },
        { name: "api_key", default: "YOUR_KEY" },
        { name: "api_key", type: "string" },
      ],
    }),
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(body(file), [
    { name: "api_key", default: "YOUR_KEY", type: "string", pages: ["/guide/"] },
  ]);
});

test("only doc pages count; an app or asset page that carries a placeholder is ignored", async () => {
  const { file } = await only(
    site(
      [
        page("/guide/", { markdown: "Set `{{api_key}}`.\n" }),
        page("/dashboard/", { kind: "app", markdown: "Set `{{api_key}}` and `{{secret}}`.\n" }),
        page("/logo.svg", { kind: "asset", markdown: "`{{file}}`\n" }),
      ],
      { variables: [{ name: "api_key", default: "YOUR_KEY", type: "string" }] },
    ),
  );
  assert.deepEqual(body(file), [
    { name: "api_key", default: "YOUR_KEY", type: "string", pages: ["/guide/"] },
  ]);
});

test("a site with no variable and no declaration writes no file", async () => {
  assert.deepEqual(await run(site([])), { files: [], diagnostics: [] });
  assert.deepEqual(await run(site([page("/guide/", { markdown: "Just prose.\n" })])), { files: [], diagnostics: [] });
  assert.deepEqual(
    await run(site([page("/guide/", { markdown: "Just prose.\n" })], { variables: "not a list" })),
    { files: [], diagnostics: [] },
  );
});

test("the file is deterministic, sorted by name, indented by two spaces, and ends with a line feed", async () => {
  const model = site(
    [
      page("/b/", { markdown: "`{{z}}` and `{{a}}`.\n" }),
      page("/a/", { markdown: "`{{z}}`.\n" }),
    ],
    {
      variables: [
        { name: "z", default: 1, type: "number" },
        { name: "a", default: 2, type: "number" },
      ],
    },
  );
  const first = await only(model);
  const second = await only(model);

  assert.deepEqual(first.file.contents, second.file.contents, "two runs write the same bytes");
  const text = String(first.file.contents);
  assert.ok(text.endsWith("\n"), "the file ends with a line feed");
  assert.match(text, /^\[\n  \{\n    "name": /, "two-space indentation");
  assert.deepEqual(
    body(first.file).map((entry) => entry.name),
    ["a", "z"],
    "names sort by code point",
  );
});

test("quotes and backslashes in a declared name, type, or default are JSON-escaped", async () => {
  const name = 'na"me\\path';
  const type = 't"ype';
  const defaultValue = 'a"b\\c';
  const { file } = await only(
    site([], { variables: [{ name, default: defaultValue, type }] }),
  );
  const text = String(file.contents);

  assert.ok(text.includes(JSON.stringify(name)), "the name is escaped in the bytes");
  assert.ok(text.includes(JSON.stringify(type)), "the type is escaped in the bytes");
  assert.ok(text.includes(JSON.stringify(defaultValue)), "the default is escaped in the bytes");
  assert.deepEqual(body(file), [{ name, default: defaultValue, type, pages: [] }]);
});

test("declarationsOf reads only a list of named mappings and trims names and types", () => {
  const declarations = declarationsOf({
    variables: [
      { name: "  api_key  ", default: "KEY", type: "  string  " },
      { name: "" },
      { name: 7 },
      { type: "string" },
      "not a mapping",
      ["not", "a", "mapping"],
      { name: "flag", default: false },
    ],
  });
  assert.deepEqual(declarations, [
    { name: "api_key", default: "KEY", type: "string" },
    { name: "flag", default: false },
  ]);
  assert.deepEqual(declarationsOf({}), []);
  assert.deepEqual(declarationsOf({ variables: { name: "api_key" } }), []);
});

test("variablesOf is a pure step over a used map and declarations", () => {
  const used = new Map<string, readonly string[]>([
    ["z", ["/b/", "/a/"]],
    ["a", []],
  ]);
  const declarations: readonly VariableDeclaration[] = [{ name: "z", default: 1, type: "number" }];
  assert.deepEqual(variablesOf(used, declarations), {
    entries: [
      { name: "a", default: null, type: "unknown", pages: [] },
      { name: "z", default: 1, type: "number", pages: ["/a/", "/b/"] },
    ],
    conflicts: [],
  });
});

test("variablesOf names the declaration that supplied the kept value in a conflict", () => {
  const declarations: readonly VariableDeclaration[] = [
    { name: "x", default: "one" },
    { name: "x", type: "string" },
    { name: "x", type: "number" },
  ];
  const { entries, conflicts } = variablesOf(new Map(), declarations);
  assert.deepEqual(entries, [{ name: "x", default: "one", type: "string", pages: [] }]);
  assert.deepEqual(conflicts, [{ name: "x", first: declarations[1], duplicate: declarations[2] }]);
});

test("usedVariables parses each page once and lists its URLs", async () => {
  const used = await usedVariables([
    page("/b/", { markdown: "`{{api_key}}` and `{{api_key}}`.\n" }),
    page("/a/", { markdown: "```\necho {{api_key}}\n```\n" }),
  ]);
  assert.deepEqual([...used], [["api_key", ["/a/", "/b/"]]]);
});
