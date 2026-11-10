import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv } from "ajv";
import type { Diagnostic, DiagnosticFix } from "../src/contracts/index.ts";
import { createDiagnostics, formatJson, formatSarif, formatText } from "../src/pipeline/diagnostics.ts";

const fix: DiagnosticFix = {
  file: "docs/guide/install.md",
  line: 3,
  column: 10,
  endLine: 3,
  endColumn: 17,
  text: "/guide/setup/",
  description: "Add a trailing slash",
};
const pos = { file: "docs/guide/install.md", line: 3, column: 5, endLine: 3, endColumn: 5 };

function sample() {
  const d = createDiagnostics();
  d.warn("link.no-slash", "Link lacks a trailing slash.", { pos, help: "Add `/`.", fix });
  d.error("config.unknown-key", "Unknown key `titel`.", { pos: { file: "slipway.yml", line: 1, column: 1, endLine: 1, endColumn: 1 } });
  return d;
}

function validator() {
  const schema = JSON.parse(readFileSync(new URL("./sarif-schema-2.1.0.json", import.meta.url), "utf8")) as Record<string, unknown>;
  delete schema["$schema"];
  delete schema["id"];
  return new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
}

test("the collector keeps a fix and leaves the field out when there is none", () => {
  const all = sample().all;
  assert.deepEqual(all[0]!.fix, fix);
  assert.equal("fix" in all[1]!, false);
});

test("a diagnostic with a fix round-trips through JSON", () => {
  const out = JSON.parse(formatJson(sample().all)) as { diagnostics: Diagnostic[] };
  const withFix = out.diagnostics.find((d) => d.id === "link.no-slash")!;
  assert.deepEqual(withFix.fix, fix);
  assert.deepEqual(withFix, sample().all[0]);
  assert.equal("fix" in out.diagnostics.find((d) => d.id === "config.unknown-key")!, false);
});

test("a diagnostic with a fix validates as SARIF 2.1.0 and carries SARIF fixes", () => {
  const validate = validator();
  const log = JSON.parse(formatSarif(sample().all)) as { runs: { columnKind?: string; results: Record<string, any>[] }[] };
  assert.equal(validate(log), true, JSON.stringify(validate.errors));
  const run = log.runs[0]!;
  assert.equal(run.columnKind, "unicodeCodePoints");
  assert.deepEqual(run.results[0]!["fixes"], [
    {
      description: { text: "Add a trailing slash" },
      artifactChanges: [
        {
          artifactLocation: { uri: "docs/guide/install.md", uriBaseId: "%SRCROOT%" },
          replacements: [
            { deletedRegion: { startLine: 3, startColumn: 10, endLine: 3, endColumn: 18 }, insertedContent: { text: "/guide/setup/" } },
          ],
        },
      ],
    },
  ]);
  assert.equal("fixes" in run.results[1]!, false);
});

test("a fix without a description, in another file, with a non-ASCII path and an empty text, is valid SARIF", () => {
  const d = createDiagnostics();
  d.error("x.y", "m", { fix: { file: "docs/فارسی/نصب 1.md", line: 1, column: 1, endLine: 2, endColumn: 4, text: "" } });
  const validate = validator();
  const log = JSON.parse(formatSarif(d.all)) as { runs: { results: Record<string, any>[] }[] };
  assert.equal(validate(log), true, JSON.stringify(validate.errors));
  const change = log.runs[0]!.results[0]!["fixes"][0];
  assert.equal("description" in change, false);
  assert.equal(change.artifactChanges[0].artifactLocation.uri, "docs/%D9%81%D8%A7%D8%B1%D8%B3%DB%8C/%D9%86%D8%B5%D8%A8%201.md");
  assert.equal(change.artifactChanges[0].replacements[0].insertedContent.text, "");
});

test("without any fix the SARIF run has no columnKind", () => {
  const d = createDiagnostics();
  d.warn("a.b", "m");
  const log = JSON.parse(formatSarif(d.all)) as { runs: Record<string, unknown>[] };
  assert.equal("columnKind" in log.runs[0]!, false);
});

test("text output names the fix for people and does not print the replacement", () => {
  const text = formatText(sample().all);
  assert.match(text, /\n {2}fix: Add a trailing slash\n/);
  assert.equal(text.includes("/guide/setup/"), false);
});
