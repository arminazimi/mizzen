import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { compareClaims, comparePages } from "../src/drift/compare.ts";
import {
  checkDocumentedSignature,
  documentedClaim,
  exportedSymbols,
  type ExportedSymbol,
} from "../src/drift/symbols.ts";

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "drift-signatures-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A Markdown page whose body starts at `line` in its source file. */
function page(file: string, markdown: string, line = 1): Page {
  return {
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { file, line, column: 1, endLine: line, endColumn: 1 },
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

/** The diagnostics of one page against one root. */
async function compare(root: string, markdown: string): Promise<Diagnostic[]> {
  return compareClaims([page("setup.md", markdown)], { root });
}

/** The one symbol `source` exports, or a failure. */
function symbolOf(source: string): ExportedSymbol {
  const [symbol] = exportedSymbols(source).symbols;
  assert.ok(symbol, "the source exports one symbol");
  return symbol;
}

/** How one documented form compares with one exported declaration. */
function check(source: string, documented: string): string {
  const claim = documentedClaim(documented);
  assert.ok(claim, `"${documented}" is a claim`);
  return checkDocumentedSignature(claim, symbolOf(source)).state;
}

/** A function with one string parameter and a promise result. */
function functionSource(): string {
  return [
    "// helpers", // 1
    "export function build(", // 2
    "  root: string,", // 3
    "  mode?: 'fast' | \"full\",", // 4
    "): Promise<Doc> {", // 5
    "  return null as never;", // 6
    "}", // 7
  ].join("\n");
}

test("exported declarations carry normalized API signatures", () => {
  const source = [
    "export function build(root: string, mode?: 'fast'): Promise<Doc> { return null as never; }",
    "export class Widget<T extends object> {",
    "  readonly id: string;",
    "  private cache = 1;",
    "  run(count: number): void {}",
    "}",
    "export interface Shape extends Base { id: string; area(): number }",
    "export type Id = string | number;",
    "export const load = (id: string): Doc => ({})",
    "export const VERSION: string = '1';",
  ].join("\n");

  const symbols = new Map(exportedSymbols(source).symbols.map((symbol) => [symbol.name, symbol]));
  assert.match(symbols.get("build")?.signatures?.[0]?.text ?? "", /^function build\(root:string, mode\?:"fast"\): Promise<Doc>$/);
  assert.deepEqual(symbols.get("build")?.signatures?.[0]?.params?.map((param) => [param.name, param.type, param.optional]), [
    ["root", "string", false],
    ["mode", '"fast"', true],
  ]);

  const widget = symbols.get("Widget")?.signatures?.[0];
  assert.equal(widget?.generics, "<T extends object>");
  assert.deepEqual(widget?.members, ["readonly id:string", "run(count:number): void"]);

  assert.equal(symbols.get("Shape")?.signatures?.[0]?.heritage, "extends Base");
  assert.deepEqual(symbols.get("Shape")?.signatures?.[0]?.members, ["id:string", "area(): number"]);
  assert.equal(symbols.get("Id")?.signatures?.[0]?.alias, "string|number");
  assert.equal(symbols.get("load")?.signatures?.[0]?.returns, "Doc");
  assert.equal(symbols.get("VERSION")?.signatures?.[0]?.alias, "string");

  // A private field is not part of the public API.
  assert.ok(!widget?.members?.some((member) => member.includes("cache")));
});

test("whitespace, comments, quote style, and formatting do not create drift", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", functionSource());
    const documented = "`build(root:string, mode?:\"fast\"|'full'):Promise< Doc >`";
    assert.deepEqual(await compare(root, `See ${documented} at src/build.ts:2.`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const classSource = [
    "export class Widget<T extends object> {",
    "  // The identity.",
    "  readonly id: string;",
    "  run(",
    "    count: number,",
    "  ): void {}",
    "}",
  ].join("\n");
  assert.equal(
    check(classSource, "class Widget<T extends object> { /* note */ readonly id: string; run(count: number): void }"),
    "match",
  );
  assert.equal(check("export type Id = 'a' | \"b\";", "type Id = \"a\" | 'b'"), "match");
});

test("parameter, optionality, generic, and return-type changes are drift on the same line", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", functionSource());
    const changed = [
      ["parameter type", "`build(root: number, mode?: 'fast' | \"full\"): Promise<Doc>`"],
      ["return type", "`build(root: string, mode?: 'fast' | \"full\"): Promise<Blob>`"],
    ] as const;

    for (const [label, documented] of changed) {
      const diagnostics = await compare(root, `See ${documented} at src/build.ts:2.`);
      assert.equal(diagnostics.length, 1, label);
      assert.equal(diagnostics[0]?.id, "drift.signature-mismatch", label);
      assert.match(diagnostics[0]?.message ?? "", /"src\/build\.ts" declares "build"/, label);
      assert.match(diagnostics[0]?.message ?? "", /line 2/, label);
      assert.ok(diagnostics[0]?.pos, label);
      assert.equal(diagnostics[0]?.pos?.file, "setup.md", label);
      assert.equal(diagnostics[0]?.pos?.line, 1, label);
    }

    // A documented optional parameter that the declaration made required is drift.
    write(root, "src/required.ts", "export function greet(name: string, mode: 'fast'): void {}\n");
    const optional = await compare(root, "See `greet(name: string, mode?: 'fast')` at /src/required.ts:1.");
    assert.equal(optional.length, 1);
    assert.equal(optional[0]?.id, "drift.signature-mismatch");

    // The declaration is still on line 2, so this is not the moved-symbol check.
    const diagnostics = await compare(root, "See `build(root: number): Promise<Doc>` at src/build.ts:2.");
    assert.equal(diagnostics[0]?.id, "drift.signature-mismatch");

    assert.equal(check("export function make<T extends string>(id: T): T { return id; }", "make<T extends number>(id: T): T"), "mismatch");
    assert.equal(check("export function make<T extends string>(id: T): T { return id; }", "make<T extends string>(id: T): T"), "match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed method, interface member, type alias, or const annotation is drift", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", [
      "export class Widget {",
      "  run(count: number): void {}",
      "}",
      "export interface Shape { id: string; area(): number }",
      "export type Id = string | number;",
      "export const VERSION: string = '1';",
    ].join("\n"));

    const cases = [
      ["widget.md", "See `class Widget { run(count: string): void }` at src/widget.ts:1."],
      ["shape.md", "See `interface Shape { id: number }` at src/widget.ts:4."],
      ["alias.md", "See `type Id = string` at src/widget.ts:5."],
      ["const.md", "See `const VERSION: number` at src/widget.ts:6."],
    ] as const;
    for (const [file, markdown] of cases) {
      const diagnostics = await compareClaims([page(file, markdown)], { root });
      assert.equal(diagnostics.length, 1, file);
      assert.equal(diagnostics[0]?.id, "drift.signature-mismatch", file);
    }

    // A documented subset of members is a valid claim; a changed one is not.
    assert.deepEqual(
      await compareClaims([page("partial.md", "See `interface Shape { id: string }` at src/widget.ts:4.")], { root }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overloads match any declared signature and may cite any overload line", async () => {
  const source = [
    "export function load(id: string): string;", // 1
    "export function load(id: number): number;", // 2
    "export function load(id: unknown): unknown {", // 3
    "  return id;", // 4
    "}", // 5
  ].join("\n");
  const root = site();
  try {
    write(root, "src/over.ts", source);
    assert.deepEqual(await compare(root, "See `load(id: number): number` at src/over.ts:2."), []);
    assert.deepEqual(await compare(root, "See `load(id: string): string` at src/over.ts:1."), []);
    assert.deepEqual(await compare(root, "See `load(id: string): string` at src/over.ts:3."), []);

    const diagnostics = await compare(root, "See `load(id: boolean): boolean` at src/over.ts:2.");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.id, "drift.signature-mismatch");
    assert.match(diagnostics[0]?.message ?? "", /line 1/);
    assert.match(diagnostics[0]?.message ?? "", /line 2/);
    assert.match(diagnostics[0]?.message ?? "", /line 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default values and async functions have documented deterministic behavior", () => {
  const untypedDefault = "export async function fetch(id: string, retries = 3): Promise<Doc> { return null as never; }";
  // A default value's type is not inferred, so a documented type is explicitly unchecked.
  assert.equal(check(untypedDefault, "fetch(id: string, retries?: number): Promise<Doc>"), "unchecked");
  assert.equal(check(untypedDefault, "async fetch(id: string, retries?: number): Promise<Doc>"), "unchecked");

  const typedDefault = "export async function fetch(id: string, retries: number = 3): Promise<Doc> { return null as never; }";
  assert.equal(check(typedDefault, "fetch(id: string, retries?: number): Promise<Doc>"), "match");
  assert.equal(check(typedDefault, "fetch(id: string, retries: number): Promise<Doc>"), "match");
  // `async` is normalized away; the return type carries it.
  assert.equal(check(typedDefault, "async fetch(id: string, retries?: number): Promise<Doc>"), "match");
  assert.equal(check(typedDefault, "fetch(id: string, retries?: string): Promise<Doc>"), "mismatch");
});

test("unsupported declarations and documented forms are explicitly unchecked, never clean", async () => {
  const root = site();
  try {
    write(root, "src/api.ts", [
      "export const answer = 42;",
      "export enum Color { Red }",
      "export { external } from './other.ts';",
    ].join("\n"));

    const cases = [
      ["const.md", "See `const answer: number` at src/api.ts:1.", /does not infer the type/],
      ["enum.md", "See `Color(value: string)` at src/api.ts:2.", /no comparable signature/],
      ["reexport.md", "See `external(id: string)` at src/api.ts:3.", /no local declaration/],
    ] as const;
    for (const [file, markdown, reason] of cases) {
      const diagnostics = await compareClaims([page(file, markdown)], { root });
      assert.equal(diagnostics.length, 1, file);
      assert.equal(diagnostics[0]?.id, "drift.signature-unchecked", file);
      assert.match(diagnostics[0]?.message ?? "", reason, file);
      assert.ok(diagnostics[0]?.pos, file);
    }

    write(root, "src/fn.ts", "export function run(task: () => void): void {}\n");
    for (const documented of ["run(...tasks)", "run({ task })"]) {
      const diagnostics = await compare(root, `See \`${documented}\` at src/fn.ts:1.`);
      assert.equal(diagnostics.length, 1, documented);
      assert.equal(diagnostics[0]?.id, "drift.signature-unchecked", documented);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmatched signature is reported, while a name-only citation keeps its old behavior", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", functionSource());

    // A name claim still checks the name and the cited line only.
    assert.deepEqual(await compare(root, "See `build` at src/build.ts:2."), []);

    // A documented call compares arity: `build()` cannot satisfy a one-required-parameter function.
    const call = await compare(root, "See `build()` at src/build.ts:2.");
    assert.equal(call.length, 1);
    assert.equal(call[0]?.id, "drift.signature-mismatch");
    assert.match(call[0]?.message ?? "", /build\(\)/);

    // A missing name is still a missing symbol, not a signature finding.
    const missing = await compare(root, "See `parseConfig()` at src/build.ts:2.");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.id, "drift.missing-symbol");

    // A claim outside the tolerance still moves.
    const moved = await compare(root, "See `build(root: string): Promise<Doc>` at src/build.ts:12.");
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.id, "drift.moved-symbol");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source bytes still identify the evidence, so a signature change invalidates it", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", functionSource());
    const model = page("guide/setup.md", "See `build(root: string, mode?: 'fast' | \"full\"): Promise<Doc>` at /src/build.ts:2.");
    const [before] = await comparePages([model], { root });
    assert.deepEqual(before?.diagnostics, []);
    assert.match(before?.identity.sources["src/build.ts"] ?? "", /^[0-9a-f]{64}$/);

    write(root, "src/build.ts", functionSource().replace("root: string", "root: number"));
    const [after] = await comparePages([model], { root });
    assert.equal(after?.identity.content, before?.identity.content);
    assert.notEqual(after?.identity.sources["src/build.ts"], before?.identity.sources["src/build.ts"]);
    assert.deepEqual(after?.diagnostics.map((diagnostic) => diagnostic.id), ["drift.signature-mismatch"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signature findings are deterministic and point at the documentation span", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", functionSource());
    const markdown = [
      "# Guide", // 1
      "", // 2
      "An intro.", // 3
      "", // 4
      "See `build(root: number): Promise<Doc>` at /src/build.ts:2.", // 5
    ].join("\n");
    const first = await compareClaims([page("guide.md", markdown)], { root });
    const second = await compareClaims([page("guide.md", markdown)], { root });
    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.id, "drift.signature-mismatch");
    assert.equal(first[0]?.pos?.line, 5);
    assert.equal(first[0]?.pos?.column, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
