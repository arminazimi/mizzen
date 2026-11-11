import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv } from "ajv";
import type { Diagnostic } from "../src/contracts/index.ts";
import { createDiagnostics, formatJson, formatSarif, formatText, sortDiagnostics } from "../src/pipeline/diagnostics.ts";

const pos = { file: "docs/guide/install.md", line: 3, column: 5, endLine: 4, endColumn: 5 };

function sample() {
  const d = createDiagnostics();
  d.warn("link.broken", "No page at /missing/.", { pos: { file: "docs/index.md", line: 1, column: 1, endLine: 1, endColumn: 1 }, help: "Fix the link." });
  d.error("config.unknown-key", "Unknown key `titel`.", { pos });
  d.info("build.note", "Built without a search index.");
  d.error("md.فارسی", "نام فایل فارسی.", { pos: { file: "docs/فارسی/نصب 1.md", line: 2, column: 1, endLine: 2, endColumn: 1 } });
  return d;
}

test("the collector keeps report order and sets hasErrors only for an error", () => {
  const d = createDiagnostics();
  assert.equal(d.hasErrors, false);
  d.warn("a.warn", "w");
  d.info("a.info", "i");
  assert.equal(d.hasErrors, false);
  d.error("a.error", "e", { pos, help: "h" });
  assert.equal(d.hasErrors, true);
  assert.deepEqual(d.all.map((x) => [x.id, x.severity]), [["a.warn", "warning"], ["a.info", "info"], ["a.error", "error"]]);
  assert.deepEqual(d.all[2], { id: "a.error", severity: "error", message: "e", pos, help: "h" });
  assert.equal("pos" in d.all[0]!, false);
});

test("report() takes a ready Diagnostic and counts an error", () => {
  const d = createDiagnostics();
  d.report({ id: "x.y", severity: "error", message: "m" });
  assert.equal(d.hasErrors, true);
  assert.equal(d.all.length, 1);
});

test("sorting is by file, line, column, id; unplaced findings come last; the input is untouched", () => {
  const input = sample().all;
  const before = input.map((d) => d.id);
  assert.deepEqual(sortDiagnostics(input).map((d) => d.id), ["config.unknown-key", "link.broken", "md.فارسی", "build.note"]);
  assert.deepEqual(input.map((d) => d.id), before);
});

test("text: path:line:col  id  message, a code frame, help, and a count", () => {
  const files: Record<string, string> = { "docs/guide/install.md": "# Install\n\nbad\ttitel: x\nnext\n" };
  const text = formatText(
    [{ id: "config.unknown-key", severity: "error", message: "Unknown key.", pos: { file: "docs/guide/install.md", line: 3, column: 5, endLine: 3, endColumn: 5 }, help: "Rename it." }],
    { source: (f) => files[f] },
  );
  assert.equal(
    text,
    [
      "docs/guide/install.md:3:5  config.unknown-key  Unknown key.",
      "  2 | ",
      "  3 | bad\ttitel: x",
      "    |    \t^",
      "  4 | next",
      "  help: Rename it.",
      "1 error, 0 warnings",
      "",
    ].join("\n"),
  );
});

test("text: no code frame without a source, and a finding without a position has no path", () => {
  const text = formatText(sample().all);
  assert.match(text, /\ndocs\/index\.md:1:1  link\.broken  No page at \/missing\/\.\n {2}help: Fix the link\.\n/);
  assert.match(text, /\nbuild\.note {2}Built without a search index\.\n/);
  assert.doesNotMatch(text, /\|/);
  assert.match(text.trimEnd().split("\n").at(-1)!, /^2 errors, 1 warning, 1 info$/);
});

test("text: a line number outside the file prints no frame instead of throwing", () => {
  const d: Diagnostic = { id: "a.b", severity: "warning", message: "m", pos: { file: "f.md", line: 99, column: 1, endLine: 99, endColumn: 1 } };
  assert.equal(formatText([d], { source: () => "one line" }), "f.md:99:1  a.b  m\n0 errors, 1 warning\n");
});

test("JSON: version, sorted diagnostics, and a round trip", () => {
  const d = sample().all;
  const parsed = JSON.parse(formatJson(d)) as { version: number; diagnostics: Diagnostic[] };
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.diagnostics, sortDiagnostics(d));
});

function validator() {
  const schema = JSON.parse(readFileSync(new URL("./sarif-schema-2.1.0.json", import.meta.url), "utf8")) as Record<string, unknown>;
  // The official schema is JSON Schema draft-04; Ajv 8 reads it once its draft-04 `$schema` and `id` are dropped.
  delete schema["$schema"];
  delete schema["id"];
  return new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
}

test("SARIF 2.1.0 output validates against the SARIF schema", () => {
  const validate = validator();
  for (const set of [sample().all, [], [{ id: "only.note", severity: "info", message: "m" } satisfies Diagnostic]]) {
    const log: unknown = JSON.parse(formatSarif(set, { tool: { name: "mizzen", version: "0.1.0", informationUri: "https://github.com/velella-sh/mizzen" } }));
    assert.equal(validate(log), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ version: "2.1.0", runs: [{ tool: {}, results: [] }] }), false, "the validator must reject an invalid log");
});

test("SARIF: levels, rules, regions, encoded URIs, and help", () => {
  const log = JSON.parse(formatSarif(sample().all)) as {
    runs: { tool: { driver: { name: string; rules: { id: string }[] } }; results: Record<string, any>[] }[];
  };
  const run = log.runs[0]!;
  assert.equal(run.tool.driver.name, "mizzen");
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ["build.note", "config.unknown-key", "link.broken", "md.فارسی"]);
  assert.deepEqual(run.results.map((r) => r["level"]), ["error", "warning", "error", "note"]);
  const first = run.results[0]!;
  assert.equal(first["ruleIndex"], 1);
  assert.deepEqual(first["locations"][0].physicalLocation, {
    artifactLocation: { uri: "docs/guide/install.md", uriBaseId: "%SRCROOT%" },
    region: { startLine: 3, startColumn: 5, endLine: 4, endColumn: 6 },
  });
  assert.equal(run.results[1]!["properties"].help, "Fix the link.");
  assert.equal(run.results[2]!["locations"][0].physicalLocation.artifactLocation.uri, "docs/%D9%81%D8%A7%D8%B1%D8%B3%DB%8C/%D9%86%D8%B5%D8%A8%201.md");
  assert.equal("locations" in run.results[3]!, false);
});
