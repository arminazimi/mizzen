import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportedSymbols } from "../src/drift/symbols.ts";
import type { ExportedSymbol } from "../src/drift/symbols.ts";

/** The `name`, `kind`, and `line` of every symbol, in scan order. */
function names(symbols: readonly ExportedSymbol[]): Array<[string, string, number]> {
  return symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line]);
}

test("every exported declaration form is found with its kind and line", () => {
  const source = [
    "export function plain() {}", // 1
    "export async function asyncFn() {}", // 2
    "export function generic<T>(value: T) { return value; }", // 3
    "export class Widget<T> {}", // 4
    "export abstract class Base {}", // 5
    "export interface Shape {}", // 6
    "export type Id = string;", // 7
    "export enum Color { Red }", // 8
    "export const enum Mode { A }", // 9
    "export const answer = 42;", // 10
    "export let mutable = 1;", // 11
    "export var legacy = 0;", // 12
    "export namespace Space {}", // 13
    "export declare const declared: number;", // 14
    "export function* generator() {}", // 15
  ].join("\n");

  assert.deepEqual(names(exportedSymbols(source).symbols), [
    ["plain", "function", 1],
    ["asyncFn", "function", 2],
    ["generic", "function", 3],
    ["Widget", "class", 4],
    ["Base", "class", 5],
    ["Shape", "interface", 6],
    ["Id", "type", 7],
    ["Color", "enum", 8],
    ["Mode", "enum", 9],
    ["answer", "const", 10],
    ["mutable", "let", 11],
    ["legacy", "var", 12],
    ["Space", "namespace", 13],
    ["declared", "const", 14],
    ["generator", "function", 15],
  ]);
});

test("re-export lists use the exported alias and keep a known local kind", () => {
  const source = [
    "export const alpha = 1;", // 1
    "export function beta() {}", // 2
    "export interface Shape {}", // 3
    "export { alpha as gamma, beta };", // 4
    "export { Shape as Form, ghost as Spirit } from './types.ts';", // 5
    "export type { Shape as Outline } from './types.ts';", // 6
    "export { type Shape as TypeShape };", // 7
  ].join("\n");

  assert.deepEqual(names(exportedSymbols(source).symbols), [
    ["alpha", "const", 1],
    ["beta", "function", 2],
    ["Shape", "interface", 3],
    ["gamma", "const", 4],
    ["Form", "interface", 5],
    ["Spirit", "const", 5],
    ["Outline", "type", 6],
    ["TypeShape", "type", 7],
  ]);
});

test("default exports cover named and anonymous functions, classes, and identifiers", () => {
  assert.deepEqual(names(exportedSymbols("export default function named() {}").symbols), [
    ["named", "function", 1],
  ]);
  assert.deepEqual(names(exportedSymbols("export default async function () {}").symbols), [
    ["default", "function", 1],
  ]);
  assert.deepEqual(names(exportedSymbols("export default class Named {}").symbols), [
    ["Named", "class", 1],
  ]);
  assert.deepEqual(names(exportedSymbols("export default class {}").symbols), [
    ["default", "class", 1],
  ]);
  assert.deepEqual(names(exportedSymbols("export default abstract class Base {}").symbols), [
    ["Base", "class", 1],
  ]);
  assert.deepEqual(names(exportedSymbols("export function actual() {}\nexport default actual;").symbols), [
    ["actual", "function", 1],
  ]);
});

test("strings, template literals, comments, and regular expressions are ignored", () => {
  const source = [
    'const one = "export function fakeOne() {}";',
    "const two = 'export const fakeTwo = 1;';",
    "const three = `export class FakeThree {}`;",
    "const four = `before ${'export let fakeFour = 1'} after`;",
    "// export interface FakeFive {}",
    "/* export enum FakeSix { A } */",
    "const seven = /export const fakeSeven = 1/g;",
    "const eight = 10 / 2; // division, not a regex",
    "export const real = 1;",
  ].join("\n");

  assert.deepEqual(names(exportedSymbols(source).symbols), [["real", "const", 9]]);
});

test("declarations inside nested blocks are not exports", () => {
  const source = [
    "if (true) { export const hidden = 1; }",
    "function outer() { export function hiddenFn() {} }",
    "{ export type Hidden = string; }",
    "const value = { export: 'not a keyword', nested: { export: 2 } };",
    "export const visible = 1;",
  ].join("\n");

  assert.deepEqual(names(exportedSymbols(source).symbols), [["visible", "const", 5]]);
});

test("line numbers follow the exported name in a multi-line declaration", () => {
  const source = [
    "export const config = {", // 1
    "  nested: {", // 2
    "    value: 1,", // 3
    "  },", // 4
    "};", // 5
    "export function", // 6
    "after<T>(", // 7
    "  value: T,", // 8
    "): T {", // 9
    "  return value;", // 10
    "}", // 11
  ].join("\n");

  assert.deepEqual(names(exportedSymbols(source).symbols), [
    ["config", "const", 1],
    ["after", "function", 7],
  ]);
});

test("a syntax error returns no symbols and one drift.symbols-syntax diagnostic", () => {
  for (const source of [
    "export function broken( {",
    "export const = 1;",
    "export { alpha beta }",
    "export function unterminated() { /*",
    "export const text = 'unterminated;",
    "export const pattern = /unterminated;",
  ]) {
    const result = exportedSymbols(source, { file: "broken.ts" });
    assert.deepEqual(result.symbols, []);
    assert.equal(result.diagnostics.length, 1);
    const diagnostic = result.diagnostics[0]!;
    assert.equal(diagnostic.id, "drift.symbols-syntax");
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.pos?.file, "broken.ts");
    assert.ok(diagnostic.pos);
    assert.ok(diagnostic.pos.line >= 1);
  }
});

test("a file path is read asynchronously and a missing file reports a diagnostic", async () => {
  const root = mkdtempSync(join(tmpdir(), "drift-symbols-"));
  try {
    const file = join(root, "example.ts");
    writeFileSync(file, "export const fromFile = 1;\n");
    const result = await exportedSymbols({ file });
    assert.deepEqual(names(result.symbols), [["fromFile", "const", 1]]);
    assert.deepEqual(result.diagnostics, []);

    const missing = await exportedSymbols({ file: join(root, "missing.ts") });
    assert.deepEqual(missing.symbols, []);
    assert.equal(missing.diagnostics.length, 1);
    assert.equal(missing.diagnostics[0]!.id, "drift.symbols-read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 1,000-line file is scanned well under 100 ms", () => {
  const lines: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    lines.push(`export const value${index} = ${index}; // line ${index}`);
  }
  const source = lines.join("\n");

  // CPU time, not wall time: the full suite runs many files in parallel, and only computing this scan counts.
  const before = process.cpuUsage();
  const result = exportedSymbols(source);
  const used = process.cpuUsage(before);
  const elapsed = (used.user + used.system) / 1000;

  assert.equal(result.symbols.length, 1000);
  assert.ok(elapsed < 100, `scan used ${elapsed.toFixed(2)} ms of CPU`);
});

test("the result is deterministic and sorted by line then name", () => {
  const source = [
    "export { zebra, alpha };",
    "export const middle = 1;",
    "export function alphaFn() {}",
    "export { beta as zebra }",
  ].join("\n");

  const first = exportedSymbols(source);
  const second = exportedSymbols(source);
  assert.deepEqual(first, second);
  assert.deepEqual(names(first.symbols), [
    ["alpha", "const", 1],
    ["zebra", "const", 1],
    ["middle", "const", 2],
    ["alphaFn", "function", 3],
  ]);
});
