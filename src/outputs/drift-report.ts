import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic, Severity, SourcePos } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { codeRefsOf, type CodeRef } from "../drift/code-refs.ts";
import { compareClaims } from "../drift/compare.ts";

/**
 * Writes `drift.json`: every drift finding the engine knows, grouped by page URL, so the theme can show a
 * drift banner and CI can fail a page that no longer matches the code it documents (N11).
 *
 * ## Shape
 *
 * ```json
 * {
 *   "pages": {
 *     "/guide/install/": [
 *       { "kind": "drift.missing-file", "reference": "src/app.ts:12", "severity": "warning" }
 *     ]
 *   }
 * }
 * ```
 *
 * A page key is its output URL, including `base`. Every finding has a fixed key order: `kind` is the
 * check ID that found it (`drift.missing-file`, `drift.moved-symbol`, and so on), `reference` is the code
 * reference the page makes, as `path:line`, `path:line-endLine`, or `path:line:column` (repository
 * relative, `/` separators), and `severity` is the diagnostic severity. A page with no findings is left
 * out; a site with none writes `{ "pages": {} }`, never a missing file.
 *
 * ## Where the findings come from
 *
 * 1. `site.data.drift`, the channel the theme's drift banner already reads (ADR 0028), in either the
 *    nested `{ pages: { "<url>": [ … ] } }` shape this output writes or the bare `{ "<url>": [ … ] }`
 *    shape. A finding there may name `kind` (or a diagnostic `id`), `reference` (or a `path`), and
 *    `severity`; a missing or unknown severity reads as `warning`. A data entry for a page wins over the
 *    computed findings, including an empty list, which says the page is clean.
 * 2. Otherwise N09's {@link compareClaims} checks the code references every page makes against the files
 *    under the site root. An output's context carries no root, so the output reads `MIZZEN_SITE_ROOT`
 *    and falls back to the process's working directory, the same convention `outputs/trust.ts` uses.
 *    Each diagnostic is matched back to the reference that earned it, by the span it carries, so the
 *    report names the cited path and line rather than a message.
 *
 * N09's checks are the only drift scanner; this output adds no check of its own.
 *
 * ## Order and determinism
 *
 * Page keys come in code-point order, and each page's findings are sorted by reference, then kind, then
 * severity. The JSON uses two-space indentation with a fixed key order and one trailing LF. For a fixed
 * site model, root, and file tree, two runs write the same bytes (ADR 0022, rule 5).
 */

/** The environment variable that names the site root, since {@link OutputContext} carries none. */
export const SITE_ROOT_ENV = "MIZZEN_SITE_ROOT";

/** One drift finding, in the exact key order `drift.json` writes. */
export interface DriftFinding {
  /** The check that found it, such as `drift.missing-file`. */
  readonly kind: string;
  /** The code reference the page makes, such as `src/app.ts:12`. */
  readonly reference: string;
  /** How serious the finding is. */
  readonly severity: Severity;
}

/** Options of {@link driftPagesOf}; both have a default that reads nothing new. */
export interface DriftReportOptions {
  /** Site root the drift checks read. Absent means the computed findings are skipped. */
  readonly root?: string;
  /** Drift data to use instead of `site.data.drift`, in either documented shape. */
  readonly data?: unknown;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a plain object, which is what a YAML mapping or a JSON object becomes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string, or `undefined` for anything else. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** A severity a finding may carry; an unknown value reads as `warning`, the severity of every N09 check. */
function severityOf(value: unknown): Severity {
  return value === "error" || value === "info" ? value : "warning";
}

/** Reads one stored finding, accepting a diagnostic's `id` and `path` as aliases, or `undefined` when it is unusable. */
function findingOf(value: unknown): DriftFinding | undefined {
  if (!isRecord(value)) return undefined;
  const kind = textOf(value.kind) ?? textOf(value.id);
  const reference = textOf(value.reference) ?? textOf(value.path);
  if (kind === undefined || reference === undefined) return undefined;
  return { kind, reference, severity: severityOf(value.severity) };
}

/**
 * The page-keyed findings in `site.data.drift`, or `undefined` when the value is not a findings map. The
 * nested form wins when its `pages` member is an object, as the drift banner reads it. A map with one
 * malformed entry is treated as no data at all, so the output falls back to the computed findings rather
 * than writing half a report.
 */
function findingsFromData(value: unknown): Map<string, DriftFinding[]> | undefined {
  if (!isRecord(value)) return undefined;
  const source = isRecord(value.pages) ? value.pages : value;
  const byUrl = new Map<string, DriftFinding[]>();
  for (const [url, entries] of Object.entries(source)) {
    if (!Array.isArray(entries)) return undefined;
    const findings: DriftFinding[] = [];
    for (const entry of entries) {
      const finding = findingOf(entry);
      if (finding === undefined) return undefined;
      findings.push(finding);
    }
    byUrl.set(url, findings);
  }
  return byUrl;
}

/** A span key that matches a diagnostic to the reference whose span it carries. */
function spanKey(pos: SourcePos): string {
  return `${pos.file}:${pos.line}:${pos.column}:${pos.endLine}:${pos.endColumn}`;
}

/** The reference a page made, back in its short form: `path:line`, `path:line-endLine`, or `path:line:column`. */
function referenceOf(ref: CodeRef): string {
  const lines = ref.endLine === undefined || ref.endLine === ref.line ? `${ref.line}` : `${ref.line}-${ref.endLine}`;
  const column = ref.column === undefined ? "" : `:${ref.column}`;
  return `${ref.path}:${lines}${column}`;
}

/** Findings grouped by page source file, which is the one fact a diagnostic carries. */
function bySourceFile(diagnostics: readonly Diagnostic[]): Map<string, Diagnostic[]> {
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const file = diagnostic.pos?.file;
    if (file === undefined) continue;
    const list = byFile.get(file);
    if (list === undefined) byFile.set(file, [diagnostic]);
    else list.push(diagnostic);
  }
  return byFile;
}

/**
 * N09's findings per page URL, or an empty map when the check cannot run. Each diagnostic is matched to
 * the reference that carries the same span, so the report names the cited path and line. A diagnostic
 * whose reference cannot be matched falls back to the span the diagnostic itself carries.
 */
async function computedFindings(pages: readonly Page[], root: string): Promise<Map<string, DriftFinding[]>> {
  const byUrl = new Map<string, DriftFinding[]>();

  let diagnostics: Diagnostic[];
  try {
    diagnostics = await compareClaims(pages, { root });
  } catch {
    return byUrl;
  }
  if (diagnostics.length === 0) return byUrl;

  const byFile = bySourceFile(diagnostics);
  for (const page of pages) {
    const pageDiagnostics = byFile.get(page.source.file);
    if (pageDiagnostics === undefined) continue;

    const references = new Map<string, string>();
    for (const ref of await codeRefsOf(page)) references.set(spanKey(ref.pos), referenceOf(ref));

    const findings: DriftFinding[] = [];
    for (const diagnostic of pageDiagnostics) {
      const pos = diagnostic.pos;
      if (pos === undefined) continue;
      const reference = references.get(spanKey(pos)) ?? `${pos.file}:${pos.line}`;
      findings.push({ kind: diagnostic.id, reference, severity: diagnostic.severity });
    }
    if (findings.length > 0) byUrl.set(page.url, findings);
  }
  return byUrl;
}

/** Findings by reference, then kind, then severity, so two runs agree on the order. */
function compareFindings(a: DriftFinding, b: DriftFinding): number {
  return (
    byCodePoint(a.reference, b.reference) ||
    byCodePoint(a.kind, b.kind) ||
    byCodePoint(a.severity, b.severity)
  );
}

/** The drift check's ordering, per URL: the page's findings by reference, then kind, with empty pages left out. */
function ordered(candidates: Map<string, DriftFinding[]>): Record<string, readonly DriftFinding[]> {
  const pages: Record<string, readonly DriftFinding[]> = {};
  for (const url of [...candidates.keys()].sort(byCodePoint)) {
    const findings = candidates.get(url) ?? [];
    if (findings.length === 0) continue;
    pages[url] = [...findings].sort(compareFindings);
  }
  return pages;
}

/**
 * The page-keyed findings the report writes. A page in `site.data.drift` (or `options.data`) wins over the
 * computed findings, including an empty list; every other page is filled from N09 when a root is known.
 * Pages with no findings are left out, so a clean site gives `{}`.
 */
export async function driftPagesOf(
  site: Site,
  options: DriftReportOptions = {},
): Promise<Record<string, readonly DriftFinding[]>> {
  const data = findingsFromData(options.data ?? site.data.drift);
  const root = options.root;
  const needsComputed =
    root !== undefined && (data === undefined || site.pages.some((page) => !data.has(page.url)));
  const computed = needsComputed ? await computedFindings(site.pages, root) : undefined;

  const candidates = new Map<string, DriftFinding[]>();
  for (const [url, findings] of data ?? []) candidates.set(url, findings);
  for (const [url, findings] of computed ?? []) {
    if (data !== undefined && data.has(url)) continue;
    candidates.set(url, findings);
  }
  return ordered(candidates);
}

/**
 * The root the output uses when no option names one: `MIZZEN_SITE_ROOT` when set, otherwise the process's
 * working directory. The caller can pass a fresh environment to test the rule without touching the process.
 */
export function driftRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[SITE_ROOT_ENV]?.trim() ?? "";
  return value === "" ? process.cwd() : value;
}

/**
 * Writes `drift.json`: every drift finding per page URL, sorted, with a fixed key order and a trailing
 * line feed. The file is always written, and a site without findings gets exactly `{ "pages": {} }`.
 */
export const driftReport: Output = {
  name: "drift-report",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const pages = await driftPagesOf(site, { root: driftRoot() });
    return [{ path: "drift.json", contents: `${JSON.stringify({ pages }, null, 2)}\n` }];
  },
};
