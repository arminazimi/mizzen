import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, DiagnosticFix, SourcePos } from "../src/contracts/index.ts";
import { createDiagnostics, formatJson, formatSarif, formatText, sortDiagnostics } from "../src/pipeline/diagnostics.ts";
import { sliceSpan } from "../src/source/spans.ts";

type Schema = {
  $schema?: string;
  $defs?: Record<string, Schema>;
  properties?: Record<string, Schema>;
  [key: string]: unknown;
};

interface Region {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations?: { physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region: Region } }[];
  properties?: { help?: string };
  fixes?: {
    description?: { text: string };
    artifactChanges: {
      artifactLocation: { uri: string; uriBaseId: string };
      replacements: { deletedRegion: Region; insertedContent: { text: string } }[];
    }[];
  }[];
}

interface SarifRule {
  id: string;
  defaultConfiguration: { level: string };
  help: { text: string };
}

interface SarifLog {
  runs: { columnKind?: string; tool: { driver: { rules: SarifRule[] } }; results: SarifResult[] }[];
}

const schema = JSON.parse(readFileSync(new URL("../schema/diagnostics.schema.json", import.meta.url), "utf8")) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/**
 * A file with one plain line, one line holding an astral character and a tab, and a final line.
 * Columns are counted the way remark and `sliceSpan` count them, so 😀 spans two columns.
 */
const source = "first\nsecond 😀\tend\nthird line\n";
const file = "docs/guide/install.md";

const singleLine: SourcePos = { file, line: 1, column: 1, endLine: 1, endColumn: 5 };
const multiline: SourcePos = { file, line: 1, column: 1, endLine: 3, endColumn: 5 };
const astral: SourcePos = { file, line: 2, column: 8, endLine: 2, endColumn: 9 };
const tab: SourcePos = { file, line: 2, column: 10, endLine: 2, endColumn: 10 };

const singleLineFix: DiagnosticFix = {
  file,
  line: 3,
  column: 1,
  endLine: 3,
  endColumn: 5,
  text: "fourth",
  description: "Rename the line",
};
const multilineFix: DiagnosticFix = { file, line: 1, column: 3, endLine: 2, endColumn: 6, text: "X" };

/** A region mapped back to the engine's inclusive span. */
function spanOfRegion(file: string, region: Region): SourcePos {
  return {
    file,
    line: region.startLine,
    column: region.startColumn,
    endLine: region.endLine,
    endColumn: region.endColumn - 1,
  };
}

function jsonOf(diagnostics: readonly Diagnostic[]): { version: number; diagnostics: Diagnostic[] } {
  return JSON.parse(formatJson(diagnostics)) as { version: number; diagnostics: Diagnostic[] };
}

function sarifOf(diagnostics: readonly Diagnostic[]): SarifLog {
  return JSON.parse(formatSarif(diagnostics)) as SarifLog;
}

test("single-line, multiline, astral, tab, and fix spans slice to the text they name", () => {
  const cases: { pos: SourcePos; text: string }[] = [
    { pos: singleLine, text: "first" },
    { pos: multiline, text: "first\nsecond 😀\tend\nthird" },
    { pos: astral, text: "😀" },
    { pos: tab, text: "\t" },
    { pos: { file, line: 3, column: 1, endLine: 3, endColumn: 5 }, text: "third" },
  ];
  for (const { pos, text } of cases) assert.equal(sliceSpan(source, pos), text, `${pos.line}:${pos.column}`);
});

test("JSON keeps every SourcePos and fix exactly and validates against the schema", () => {
  const d = createDiagnostics();
  const cases: { id: string; pos: SourcePos; fix?: DiagnosticFix }[] = [
    { id: "span.single", pos: singleLine },
    { id: "span.multiline", pos: multiline },
    { id: "span.astral", pos: astral },
    { id: "span.tab", pos: tab },
    { id: "span.single-fix", pos: { file, line: 3, column: 1, endLine: 3, endColumn: 5 }, fix: singleLineFix },
    { id: "span.multiline-fix", pos: multiline, fix: multilineFix },
  ];
  for (const { id, pos, fix } of cases) d.warn(id, "m", { pos, ...(fix === undefined ? {} : { fix }) });

  const parsed = jsonOf(d.all);
  assert.equal(parsed.version, 1);
  for (const { id, pos, fix } of cases) {
    const found = parsed.diagnostics.find((x) => x.id === id);
    assert.ok(found, id);
    assert.deepEqual(found.pos, pos, id);
    if (fix !== undefined) assert.deepEqual(found.fix, fix, id);
    else assert.equal("fix" in found, false, id);
  }
  assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
});

test("SARIF regions carry the exclusive end that maps back to the exact SourcePos", () => {
  const d = createDiagnostics();
  const cases: { id: string; pos: SourcePos; fix?: DiagnosticFix }[] = [
    { id: "span.single", pos: singleLine },
    { id: "span.multiline", pos: multiline },
    { id: "span.astral", pos: astral },
    { id: "span.tab", pos: tab },
    { id: "span.single-fix", pos: { file, line: 3, column: 1, endLine: 3, endColumn: 5 }, fix: singleLineFix },
    { id: "span.multiline-fix", pos: multiline, fix: multilineFix },
  ];
  for (const { id, pos, fix } of cases) d.warn(id, "m", { pos, ...(fix === undefined ? {} : { fix }) });

  const run = sarifOf(d.all).runs[0]!;
  assert.equal(run.columnKind, "unicodeCodePoints", "a region's columns are declared");
  for (const { id, pos, fix } of cases) {
    const result = run.results.find((r) => r.ruleId === id);
    assert.ok(result, id);
    const region = result.locations?.[0]?.physicalLocation.region;
    assert.ok(region, id);
    assert.deepEqual(
      region,
      { startLine: pos.line, startColumn: pos.column, endLine: pos.endLine, endColumn: pos.endColumn + 1 },
      id,
    );
    assert.deepEqual(spanOfRegion(file, region), pos, id);
    if (fix !== undefined) {
      const deleted = result.fixes?.[0]?.artifactChanges[0]?.replacements[0]?.deletedRegion;
      assert.ok(deleted, id);
      assert.deepEqual(spanOfRegion(file, deleted), {
        file: fix.file,
        line: fix.line,
        column: fix.column,
        endLine: fix.endLine,
        endColumn: fix.endColumn,
      });
      assert.equal(result.fixes?.[0]?.artifactChanges[0]?.replacements[0]?.insertedContent.text, fix.text);
    }
  }
});

test("SARIF regions keep astral and percent-encoded paths exact", () => {
  const unicodeFile = "docs/فارسی/نصب 1.md";
  const d = createDiagnostics();
  d.warn("span.astral", "m", { pos: astral });
  d.error("span.unicode", "m", { pos: { file: unicodeFile, line: 2, column: 8, endLine: 2, endColumn: 9 } });

  const run = sarifOf(d.all).runs[0]!;
  for (const [result, expected] of [
    [run.results.find((r) => r.ruleId === "span.astral")!, astral],
    [run.results.find((r) => r.ruleId === "span.unicode")!, { ...astral, file: unicodeFile }],
  ] as const) {
    const uri = result.locations?.[0]?.physicalLocation.artifactLocation.uri;
    assert.ok(uri, expected.file);
    assert.equal(uri.includes(" "), false, "a path is percent-encoded");
    assert.equal(decodeURIComponent(uri), expected.file, "encoding keeps the path exact");
    const region = result.locations?.[0]?.physicalLocation.region;
    assert.ok(region);
    assert.deepEqual(spanOfRegion(expected.file, region), expected);
  }
});

test("every rule has a deterministic level and help, and every result its index and full region", () => {
  const d = createDiagnostics();
  d.info("z.duplicate", "The info finding.");
  d.error("a.duplicate", "The error finding.", { pos: singleLine, help: "Error help." });
  d.warn("a.duplicate", "The warning finding.", { help: "Warning help." });
  d.warn("b.fixable", "Add a trailing slash.", { pos: { file, line: 3, column: 10, endLine: 3, endColumn: 17 }, fix: singleLineFix });
  d.info("c.plain", "Built without a search index.");

  const log = sarifOf(d.all);
  const run = log.runs[0]!;
  const rules = run.tool.driver.rules;
  assert.deepEqual(rules.map((r) => r.id), ["a.duplicate", "b.fixable", "c.plain", "z.duplicate"]);
  assert.deepEqual(rules.map((r) => r.defaultConfiguration.level), ["error", "warning", "note", "note"]);
  assert.equal(rules.find((r) => r.id === "a.duplicate")?.help.text, "Error help.", "the first help in sorted order");
  assert.equal(rules.find((r) => r.id === "b.fixable")?.help.text, "Add a trailing slash.", "help falls back to the message");
  assert.equal(rules.find((r) => r.id === "c.plain")?.help.text, "Built without a search index.");
  assert.equal(rules.find((r) => r.id === "z.duplicate")?.help.text, "The info finding.");

  for (const result of run.results) {
    assert.equal(result.ruleIndex, rules.findIndex((r) => r.id === result.ruleId), result.ruleId);
    if (result.locations) {
      const region = result.locations[0]!.physicalLocation.region;
      assert.ok(region.endLine >= region.startLine, result.ruleId);
      if (region.endLine === region.startLine) assert.ok(region.endColumn > region.startColumn, result.ruleId);
      assert.deepEqual(Object.keys(region).sort(), ["endColumn", "endLine", "startColumn", "startLine"], result.ruleId);
    }
  }

  const warning = run.results.find((r) => r.ruleId === "a.duplicate" && r.level === "warning")!;
  assert.equal(warning.properties?.help, "Warning help.", "per-result help survives");
  assert.deepEqual(warning.locations, undefined);
  const plain = run.results.find((r) => r.ruleId === "c.plain")!;
  assert.deepEqual(plain.properties, undefined);
  const fixable = run.results.find((r) => r.ruleId === "b.fixable")!;
  assert.equal(fixable.properties, undefined, "a rule's help is not copied onto a result that has none");
  assert.equal(fixable.fixes?.length, 1, "per-result fixes survive");

  assert.equal(formatSarif([...d.all].reverse()), formatSarif(d.all), "the input order does not change the report");
});

test("the JSON schema accepts every emitted envelope", () => {
  const sets: readonly Diagnostic[][] = [
    [],
    [{ id: "only.note", severity: "info", message: "m" }],
    [
      { id: "with.everything", severity: "error", message: "m", pos: multiline, help: "h", fix: multilineFix },
      { id: "with.fix", severity: "warning", message: "m", fix: { ...singleLineFix, description: "" } },
      { id: "with.unicode.path", severity: "info", message: "m", pos: { file: "docs/فارسی/نصب 1.md", line: 1, column: 1, endLine: 1, endColumn: 1 } },
    ],
  ];
  for (const set of sets) {
    const parsed = jsonOf(set);
    assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
  }
});

test("the JSON schema rejects malformed versions, severities, paths, positions, and fixes", () => {
  const valid = {
    version: 1,
    diagnostics: [
      {
        id: "a.b",
        severity: "warning",
        message: "m",
        pos: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
        help: "h",
        fix: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 1, text: "x" },
      },
    ],
  };
  assert.equal(validate(valid), true, "the base envelope is valid");

  type Mutable = {
    version: unknown;
    diagnostics: {
      id?: unknown;
      severity?: unknown;
      message?: unknown;
      help?: unknown;
      pos?: Record<string, unknown> | null;
      fix?: Record<string, unknown> | null;
      [key: string]: unknown;
    }[];
  };
  const bad: [string, unknown][] = [];
  const mutate = (name: string, change: (value: Mutable) => void): void => {
    const value = structuredClone(valid) as unknown as Mutable;
    change(value);
    bad.push([name, value]);
  };

  mutate("another version", (v) => (v.version = 2));
  mutate("a string version", (v) => (v.version = "1"));
  mutate("no diagnostics", (v) => delete (v as { diagnostics?: unknown }).diagnostics);
  mutate("diagnostics not an array", (v) => (v.diagnostics = {} as never));
  mutate("an extra envelope key", (v) => ((v as Record<string, unknown>)["exitCode"] = 0));

  const first = (v: Mutable) => v.diagnostics[0]!;
  mutate("an unknown severity", (v) => (first(v).severity = "fatal"));
  mutate("a differently cased severity", (v) => (first(v).severity = "WARNING"));
  mutate("no severity", (v) => delete first(v).severity);
  mutate("no id", (v) => delete first(v).id);
  mutate("an empty id", (v) => (first(v).id = ""));
  mutate("no message", (v) => delete first(v).message);
  mutate("a numeric help", (v) => (first(v).help = 1));
  mutate("an unknown finding key", (v) => (first(v)["ruleId"] = "a.b"));
  mutate("a null position", (v) => (first(v).pos = null));

  mutate("a zero line", (v) => (first(v).pos!["line"] = 0));
  mutate("a negative column", (v) => (first(v).pos!["column"] = -1));
  mutate("a fractional end column", (v) => (first(v).pos!["endColumn"] = 1.5));
  mutate("a string end line", (v) => (first(v).pos!["endLine"] = "1"));
  mutate("no end column", (v) => delete first(v).pos!["endColumn"]);
  mutate("no file", (v) => delete first(v).pos!["file"]);
  mutate("an absolute path", (v) => (first(v).pos!["file"] = "/etc/passwd"));
  mutate("a drive path", (v) => (first(v).pos!["file"] = "C:/docs/a.md"));
  mutate("a backslash path", (v) => (first(v).pos!["file"] = "docs\\a.md"));
  mutate("a parent segment", (v) => (first(v).pos!["file"] = "../a.md"));
  mutate("a dot segment", (v) => (first(v).pos!["file"] = "docs/./a.md"));
  mutate("an empty path", (v) => (first(v).pos!["file"] = ""));
  mutate("an extra position key", (v) => (first(v).pos!["offset"] = 0));

  mutate("a fix with no text", (v) => delete first(v).fix!["text"]);
  mutate("a numeric fix text", (v) => (first(v).fix!["text"] = 1));
  mutate("a zero fix line", (v) => (first(v).fix!["line"] = 0));
  mutate("a fix with no end line", (v) => delete first(v).fix!["endLine"]);
  mutate("a fix with an absolute path", (v) => (first(v).fix!["file"] = "/a.md"));
  mutate("a fix with a parent segment", (v) => (first(v).fix!["file"] = "docs/../a.md"));
  mutate("a fix with a numeric description", (v) => (first(v).fix!["description"] = 1));
  mutate("a fix with an extra key", (v) => (first(v).fix!["mode"] = "insert"));
  mutate("a null fix", (v) => (first(v).fix = null));

  for (const [name, value] of bad) assert.equal(validate(value), false, name);
});

test("JSON and SARIF keep the same stable order and lose no help or fix", () => {
  const d = createDiagnostics();
  d.info("m.note", "A note.");
  d.warn("z.warn", "A warning.", { pos: { file, line: 2, column: 8, endLine: 2, endColumn: 9 }, help: "Z help." });
  d.error("a.error", "An error.", { pos: singleLine, help: "A help.", fix: singleLineFix });

  const order = sortDiagnostics(d.all).map((x) => x.id);
  assert.deepEqual(order, ["a.error", "z.warn", "m.note"]);

  const json = jsonOf(d.all).diagnostics;
  assert.deepEqual(json.map((x) => x.id), order);
  const sarif = sarifOf(d.all).runs[0]!.results;
  assert.deepEqual(sarif.map((r) => r.ruleId), order);

  for (const finding of d.all) {
    const fromJson = json.find((x) => x.id === finding.id);
    assert.ok(fromJson, finding.id);
    assert.equal(fromJson.help, finding.help);
    assert.deepEqual(fromJson.fix, finding.fix);

    const fromSarif = sarif.find((r) => r.ruleId === finding.id);
    assert.ok(fromSarif, finding.id);
    assert.equal(fromSarif.properties?.help, finding.help);
    assert.equal(fromSarif.fixes?.length, finding.fix === undefined ? undefined : 1);
  }
  assert.match(formatText(d.all), /\n {2}help: A help\.\n/);
  assert.match(formatText(d.all), /\n {2}fix: Rename the line\n/);
});

test("the schema is draft 2020-12 and closed", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
});
