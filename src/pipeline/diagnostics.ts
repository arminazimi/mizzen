import type { Diagnostic, DiagnosticFix, Severity } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";

/** What a caller may add to a finding beyond its id and message. */
export interface DiagnosticOptions {
  /** Where in the source the problem is. */
  readonly pos?: SourcePos;
  /** How to fix it. */
  readonly help?: string;
  /** A safe, mechanical repair on a source span. */
  readonly fix?: DiagnosticFix;
}

/** Collects the findings of one build, in the order they were reported. */
export interface Diagnostics {
  /** Reports a finding that fails the build. */
  error(id: string, message: string, options?: DiagnosticOptions): void;
  /** Reports a finding that does not fail the build. */
  warn(id: string, message: string, options?: DiagnosticOptions): void;
  /** Reports a finding for the reader's information. */
  info(id: string, message: string, options?: DiagnosticOptions): void;
  /** Adds a finding that already is a `Diagnostic`, such as one an output reports. */
  report(diagnostic: Diagnostic): void;
  /** True once any `error` was reported. */
  readonly hasErrors: boolean;
  /** Every finding so far, in report order. */
  readonly all: readonly Diagnostic[];
}

/** Creates an empty collector. */
export function createDiagnostics(): Diagnostics {
  const all: Diagnostic[] = [];
  let hasErrors = false;
  const add = (severity: Severity) => (id: string, message: string, options: DiagnosticOptions = {}): void => {
    const diagnostic: Diagnostic = {
      id,
      severity,
      message,
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      ...(options.help === undefined ? {} : { help: options.help }),
      ...(options.fix === undefined ? {} : { fix: options.fix }),
    };
    all.push(diagnostic);
    if (severity === "error") hasErrors = true;
  };
  return {
    error: add("error"),
    warn: add("warning"),
    info: add("info"),
    report(diagnostic) {
      all.push(diagnostic);
      if (diagnostic.severity === "error") hasErrors = true;
    },
    get hasErrors() {
      return hasErrors;
    },
    all,
  };
}

/** Orders findings by file, line, column, then id; findings without a position come last. Does not change its input. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((d, index) => ({ d, index }))
    .sort((a, b) => {
      const p = a.d.pos;
      const q = b.d.pos;
      if (p && !q) return -1;
      if (!p && q) return 1;
      if (p && q) {
        if (p.file !== q.file) return p.file < q.file ? -1 : 1;
        if (p.line !== q.line) return p.line - q.line;
        if (p.column !== q.column) return p.column - q.column;
      }
      if (a.d.id !== b.d.id) return a.d.id < b.d.id ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ d }) => d);
}

/** Options of {@link formatText}. */
export interface TextOptions {
  /** Returns the text of a source file (path as in `SourcePos.file`) or `undefined`; without it no code frame is printed. */
  readonly source?: (file: string) => string | undefined;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A code frame: the line of the problem with one line of context on each side and a caret under the column. */
function codeFrame(text: string, pos: SourcePos): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (pos.line < 1 || pos.line > lines.length) return [];
  const first = Math.max(1, pos.line - 1);
  const last = Math.min(lines.length, pos.line + 1);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const line = lines[n - 1] ?? "";
    out.push(`  ${String(n).padStart(width)} | ${line}`);
    if (n === pos.line) {
      // Keep tabs so the caret lines up with the source above it.
      const lead = Array.from(line.slice(0, Math.max(0, pos.column - 1)), (c) => (c === "\t" ? "\t" : " ")).join("");
      const missing = Math.max(0, pos.column - 1 - line.length);
      out.push(`  ${" ".repeat(width)} | ${lead}${" ".repeat(missing)}^`);
    }
  }
  return out;
}

/** Prints for people: `path:line:col  id  message`, a code frame when the source is known, the help, and a count. */
export function formatText(diagnostics: readonly Diagnostic[], options: TextOptions = {}): string {
  const out: string[] = [];
  for (const d of sortDiagnostics(diagnostics)) {
    const where = d.pos ? `${d.pos.file}:${d.pos.line}:${d.pos.column}  ` : "";
    out.push(`${where}${d.id}  ${d.message}`);
    const text = d.pos ? options.source?.(d.pos.file) : undefined;
    if (d.pos && text !== undefined) out.push(...codeFrame(text, d.pos));
    if (d.help) out.push(`  help: ${d.help}`);
    if (d.fix?.description) out.push(`  fix: ${d.fix.description}`);
  }
  const count = (severity: Severity) => diagnostics.filter((d) => d.severity === severity).length;
  const parts = [plural(count("error"), "error"), plural(count("warning"), "warning")];
  if (count("info") > 0) parts.push(`${count("info")} info`);
  out.push(parts.join(", "));
  return `${out.join("\n")}\n`;
}

/** Prints for machines: `{ "version": 1, "diagnostics": [...] }`, sorted, two-space indent, trailing newline. */
export function formatJson(diagnostics: readonly Diagnostic[]): string {
  return `${JSON.stringify({ version: 1, diagnostics: sortDiagnostics(diagnostics) }, null, 2)}\n`;
}

/** Options of {@link formatSarif}. */
export interface SarifOptions {
  /** The tool that found the problems; defaults to the name `mizzen`. */
  readonly tool?: { readonly name: string; readonly version?: string; readonly informationUri?: string };
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note" };

/** Percent-encodes a repository-relative path for a SARIF URI, keeping the `/` separators. */
const sarifUri = (file: string): string => file.split("/").map(encodeURIComponent).join("/");

/** A SARIF `fix`: one replacement. SARIF's `endColumn` is exclusive, ours is inclusive. */
function sarifFix(fix: DiagnosticFix) {
  return {
    ...(fix.description === undefined ? {} : { description: { text: fix.description } }),
    artifactChanges: [
      {
        artifactLocation: { uri: sarifUri(fix.file), uriBaseId: "%SRCROOT%" },
        replacements: [
          {
            deletedRegion: { startLine: fix.line, startColumn: fix.column, endLine: fix.endLine, endColumn: fix.endColumn + 1 },
            insertedContent: { text: fix.text },
          },
        ],
      },
    ],
  };
}

/** Prints SARIF 2.1.0, one run, one rule per id, `help` kept in each result's `properties`, a `fix` as SARIF `fixes`. */
export function formatSarif(diagnostics: readonly Diagnostic[], options: SarifOptions = {}): string {
  const sorted = sortDiagnostics(diagnostics);
  const ids = [...new Set(sorted.map((d) => d.id))].sort();
  const driver = {
    name: options.tool?.name ?? "mizzen",
    ...(options.tool?.version === undefined ? {} : { version: options.tool.version }),
    ...(options.tool?.informationUri === undefined ? {} : { informationUri: options.tool.informationUri }),
    rules: ids.map((id) => ({ id })),
  };
  const results = sorted.map((d) => ({
    ruleId: d.id,
    ruleIndex: ids.indexOf(d.id),
    level: SARIF_LEVEL[d.severity],
    message: { text: d.message },
    ...(d.pos
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: sarifUri(d.pos.file), uriBaseId: "%SRCROOT%" },
                region: { startLine: d.pos.line, startColumn: d.pos.column, endLine: d.pos.endLine },
              },
            },
          ],
        }
      : {}),
    ...(d.help ? { properties: { help: d.help } } : {}),
    ...(d.fix ? { fixes: [sarifFix(d.fix)] } : {}),
  }));
  const log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver }, ...(sorted.some((d) => d.fix) ? { columnKind: "unicodeCodePoints" } : {}), results }],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
