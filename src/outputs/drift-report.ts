import type { Page, Site } from "../contracts/content.ts";
import type { Severity, SourcePos } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import type { CodeRef } from "../drift/code-refs.ts";
import { comparePages, driftContentOf, type ClaimComparison } from "../drift/compare.ts";

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
 *       {
 *         "kind": "drift.missing-file",
 *         "reference": "src/app.ts:12",
 *         "severity": "warning",
 *         "message": "Cannot check the reference to \"src/app.ts\": the file does not exist.",
 *         "help": "Update the path or restore the file.",
 *         "source": { "file": "guide/install.md", "line": 4, "column": 6, "endLine": 4, "endColumn": 20 },
 *         "target": { "path": "src/app.ts", "line": 12, "identity": "missing" }
 *       }
 *     ]
 *   },
 *   "coverage": {
 *     "/guide/install/": { "checked": true, "findings": 1 }
 *   },
 *   "evidence": {
 *     "/guide/install/": {
 *       "version": 1,
 *       "state": "fresh",
 *       "content": "6f…",
 *       "sources": { "src/app.ts": "9c…" }
 *     }
 *   }
 * }
 * ```
 *
 * A page key is its output URL, including `base`. Every finding has a fixed key order: `kind` is the
 * check ID that found it (`drift.missing-file`, `drift.moved-symbol`, and so on), `reference` is the code
 * reference the page makes, as `path:line`, `path:line-endLine`, or `path:line:column` (repository
 * relative, `/` separators), and `severity` is the diagnostic severity. A computed finding then carries
 * the diagnostic's `message` and `help`, the exact documentation `source` span it was judged at, and the
 * structured `target` it cites: the code path, lines, optional column, and the source identity from
 * `evidence` for that path (a SHA-256, `missing`, or `outside`). A hand-written finding only has the
 * fields its data supplied, so older `site.data.drift` entries stay readable.
 *
 * `coverage` names every doc page, including pages with no findings, so a clean page is distinguishable
 * from one that was never measured: `checked` is true only when this run measured the page (or reused
 * evidence that still matches), and `findings` is how many findings the report holds for it. A page with
 * no findings is left out of `pages`; a site with none writes `{ "pages": {} }` under that key, never a
 * missing file. `schema/drift.schema.json` describes the same shape.
 *
 * ## Evidence
 *
 * Findings are only true for the exact bytes they were computed from, so every doc page also gets an
 * `evidence` entry: the identity of the page's content and of each source it cites, plus a `state`.
 * The keys are, in order, `version`, `state`, `content` (SHA-256, absent when nothing was measured), and
 * `sources` (path to SHA-256, or to `missing`/`outside`). A URL with no evidence entry has no evidence;
 * missing evidence is never written as fresh.
 *
 * - `fresh`: measured in this run, or stored evidence whose content and source hashes still match.
 * - `stale`: stored evidence whose page content, cited paths, or source bytes have since changed.
 * - `unknown`: no evidence at all, such as a hand-written finding that carries none, or a page no root
 *   let the engine check.
 * - `unavailable`: evidence exists, but the sources could not be read now, so it could not be verified.
 *
 * ## Where the findings come from
 *
 * 1. `site.data.drift`, the channel the theme's drift banner already reads, in either the
 *    nested `{ pages: { "<url>": [ … ] }, evidence?: { … } }` shape this output writes or the bare
 *    `{ "<url>": [ … ] }` shape. A finding there may name `kind` (or a diagnostic `id`), `reference` (or
 *    a `path`), `severity`, `message`, `help`, `source` (or a diagnostic `pos`), and `target`; a missing
 *    or unknown severity reads as `warning`, and absent optional fields stay absent. A data entry for a
 *    page wins over the computed findings, including an empty list. A stored `evidence` entry is checked
 *    against the current page content and source bytes: while it matches, the stored findings stand; once
 *    it does not, the page is recomputed when a root is known and marked `stale` otherwise. An entry
 *    without evidence is a hand-written override, so it is kept but never claimed fresh.
 * 2. Otherwise N09's {@link comparePages} checks the code references every page makes against the files
 *    under the site root. An output's context carries no root, so the output reads `MIZZEN_SITE_ROOT`
 *    and falls back to the process's working directory, the same convention `outputs/trust.ts` uses.
 *    Each diagnostic is matched back to the reference that earned it, by the span it carries, so the
 *    report names the cited path and line while keeping the diagnostic's message, help, and span. The
 *    same pass returns the identity the findings were computed from, which is what `evidence` records.
 *
 * N09's checks are the only drift scanner; this output adds no check of its own.
 *
 * ## Order and determinism
 *
 * Page keys come in code-point order, and each page's findings are sorted by reference, then kind, then
 * severity, then source span, then message. `coverage` and `evidence` keys follow the same page order,
 * and source keys within one identity are sorted by path. The JSON uses two-space indentation with a
 * fixed key order and one trailing LF. For a fixed site model, root, and file tree, two runs write the
 * same bytes; no absolute path or wall-clock value is written.
 */

/** The environment variable that names the site root, since {@link OutputContext} carries none. */
export const SITE_ROOT_ENV = "MIZZEN_SITE_ROOT";

/** Bumped when the meaning or shape of an evidence entry changes, so older entries are never trusted. */
export const DRIFT_EVIDENCE_VERSION = 1;

/** How far a page's drift evidence can be trusted. */
export type DriftState = "fresh" | "stale" | "unknown" | "unavailable";

/** The identity of what a page's findings were computed from, and whether it still holds. */
export interface DriftEvidence {
  /** The evidence format; only {@link DRIFT_EVIDENCE_VERSION} is read. */
  readonly version: number;
  /** Whether the findings match the current content and sources. */
  readonly state: DriftState;
  /** SHA-256 of the page content the findings came from; absent when nothing was measured. */
  readonly content?: string;
  /** Per cited path, the source identity the findings came from; absent when nothing was measured. */
  readonly sources?: Readonly<Record<string, string>>;
}

/** The structured code target a finding judged, as the comparison knew it. */
export interface DriftTarget {
  /** The cited file, relative to the repository root, using `/`. */
  readonly path: string;
  /** The first cited line. */
  readonly line: number;
  /** The last cited line of a range; absent for one line. */
  readonly endLine?: number;
  /** The cited column; absent when the reference names only lines. */
  readonly column?: number;
  /** The source identity from `evidence` for this path: a SHA-256, `missing`, or `outside`. */
  readonly identity: string;
}

/** One drift finding, in the exact key order `drift.json` writes. */
export interface DriftFinding {
  /** The check that found it, such as `drift.missing-file`. */
  readonly kind: string;
  /** The code reference the page makes, such as `src/app.ts:12`. */
  readonly reference: string;
  /** How serious the finding is. */
  readonly severity: Severity;
  /** What is wrong, in one sentence; always present on a computed finding. */
  readonly message?: string;
  /** How to fix it; present when the check offers a repair. */
  readonly help?: string;
  /** The exact documentation span the finding was judged at. */
  readonly source?: SourcePos;
  /** The structured code target and its identity, when the comparison knew them. */
  readonly target?: DriftTarget;
}

/** How many findings a page has, and whether this run actually measured it. */
export interface DriftPageCoverage {
  /** True only when this run measured the page, or reused stored evidence that still matches. */
  readonly checked: boolean;
  /** The number of findings the report holds for the page, including zero. */
  readonly findings: number;
}

/** The `drift.json` body: findings per page URL, per-page coverage, and the evidence behind them. */
export interface DriftReportBody {
  /** Findings per page URL, in code-point key order. */
  readonly pages: Record<string, readonly DriftFinding[]>;
  /** One entry per doc page, so a clean page is not confused with an unmeasured one. */
  readonly coverage: Record<string, DriftPageCoverage>;
  /** Evidence per doc page URL, in code-point key order. */
  readonly evidence: Record<string, DriftEvidence>;
}

/** Options of {@link driftReportOf}; both have a default that reads nothing new. */
export interface DriftReportOptions {
  /** Site root the drift checks read. Absent means the computed findings are skipped. */
  readonly root?: string;
  /** Drift data to use instead of `site.data.drift`, in either documented shape. */
  readonly data?: unknown;
}

/** Every state an evidence entry may carry. */
const STATES: readonly DriftState[] = ["fresh", "stale", "unknown", "unavailable"];

/** Compares by code point, never by locale. */
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

/** True for one of {@link STATES}. */
function isState(value: unknown): value is DriftState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** A SHA-256 as the report writes and reads it. */
const HASH = /^[0-9a-f]{64}$/;

/** A source identity: a SHA-256, or the marker that says why the source was not read. */
const SOURCE_IDENTITY = /^(?:[0-9a-f]{64}|missing|outside)$/;

/** True for a SHA-256 string. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

/** A source identity from stored evidence, or `undefined` when it is not one this report writes. */
function identityOf(value: unknown): string | undefined {
  return typeof value === "string" && SOURCE_IDENTITY.test(value) ? value : undefined;
}

/** True for a positive integer, as every line and column is. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A source span with valid 1-based parts and an end at or after its start, or `undefined`. */
function spanOf(value: unknown): SourcePos | undefined {
  if (!isRecord(value)) return undefined;
  const file = textOf(value.file);
  const line = value.line;
  const column = value.column;
  const endLine = value.endLine;
  const endColumn = value.endColumn;
  if (file === undefined || !isPositiveInteger(line) || !isPositiveInteger(column)) return undefined;
  if (!isPositiveInteger(endLine) || !isPositiveInteger(endColumn)) return undefined;
  if (endLine < line || (endLine === line && endColumn < column)) return undefined;
  return { file, line, column, endLine, endColumn };
}

/** The structured target the comparison knew for one reference. */
function targetOf(ref: CodeRef, identity: string | undefined): DriftTarget | undefined {
  if (identity === undefined) return undefined;
  return {
    path: ref.path,
    line: ref.line,
    ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
    ...(ref.column === undefined ? {} : { column: ref.column }),
    identity,
  };
}

/** A stored target, or `undefined` when it is malformed. */
function targetFromData(value: unknown): DriftTarget | undefined {
  if (!isRecord(value)) return undefined;
  const path = textOf(value.path);
  const line = value.line;
  const identity = identityOf(value.identity);
  if (path === undefined || !isPositiveInteger(line) || identity === undefined) return undefined;
  const endLine = value.endLine;
  const column = value.column;
  if (endLine !== undefined && !isPositiveInteger(endLine)) return undefined;
  if (column !== undefined && !isPositiveInteger(column)) return undefined;
  return {
    path,
    line,
    ...(endLine === undefined ? {} : { endLine }),
    ...(column === undefined ? {} : { column }),
    identity,
  };
}

/** Reads one stored finding, accepting a diagnostic's `id`, `path`, and `pos` as aliases. */
function findingOf(value: unknown): DriftFinding | undefined {
  if (!isRecord(value)) return undefined;
  const kind = textOf(value.kind) ?? textOf(value.id);
  const reference = textOf(value.reference) ?? textOf(value.path);
  if (kind === undefined || reference === undefined) return undefined;

  const message = textOf(value.message);
  const help = textOf(value.help);
  const sourceValue = value.source ?? value.pos;
  const source = sourceValue === undefined ? undefined : spanOf(sourceValue);
  const target = value.target === undefined ? undefined : targetFromData(value.target);
  // An optional field the data supplied must be usable; a malformed one is a malformed finding.
  if (value.message !== undefined && message === undefined) return undefined;
  if (value.help !== undefined && help === undefined) return undefined;
  if (sourceValue !== undefined && source === undefined) return undefined;
  if (value.target !== undefined && target === undefined) return undefined;

  return {
    kind,
    reference,
    severity: severityOf(value.severity),
    ...(message === undefined ? {} : { message }),
    ...(help === undefined ? {} : { help }),
    ...(source === undefined ? {} : { source }),
    ...(target === undefined ? {} : { target }),
  };
}

/**
 * The page-keyed findings in `site.data.drift`, or `undefined` when the value is not a findings map. The
 * nested form wins when its `pages` member is an object, as the drift banner reads it. A map with one
 * malformed entry is treated as no data at all, so the output falls back to the computed findings rather
 * than writing half a report. `evidence` is not a page URL; the bare form skips it.
 */
function findingsFromData(value: unknown): Map<string, DriftFinding[]> | undefined {
  if (!isRecord(value)) return undefined;
  const pages = isRecord(value.pages) ? value.pages : undefined;
  const source = pages ?? value;
  const nested = pages !== undefined;
  const byUrl = new Map<string, DriftFinding[]>();
  for (const [url, entries] of Object.entries(source)) {
    if (!nested && !url.startsWith("/")) continue;
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

/** A source map from a stored identity, with its paths in code-point order; `undefined` when malformed. */
function sourcesOfEvidence(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const path of Object.keys(value).sort(byCodePoint)) {
    const identity = identityOf(value[path]);
    if (identity === undefined) return undefined;
    out[path] = identity;
  }
  return out;
}

/** One stored evidence entry, or `undefined` when its shape or version is not one this build wrote. */
function evidenceOf(value: unknown): DriftEvidence | undefined {
  if (!isRecord(value) || value.version !== DRIFT_EVIDENCE_VERSION || !isState(value.state)) return undefined;
  const content = value.content === undefined ? undefined : isHash(value.content) ? value.content : undefined;
  if (value.content !== undefined && content === undefined) return undefined;
  const sources = sourcesOfEvidence(value.sources);
  return {
    version: DRIFT_EVIDENCE_VERSION,
    state: value.state,
    ...(content === undefined ? {} : { content }),
    ...(sources === undefined ? {} : { sources }),
  };
}

/** The stored evidence in a data value, keyed by page URL; `undefined` when the value carries none. */
function evidenceFromData(value: unknown): Map<string, DriftEvidence> | undefined {
  if (!isRecord(value) || !isRecord(value.evidence)) return undefined;
  const byUrl = new Map<string, DriftEvidence>();
  for (const [url, entry] of Object.entries(value.evidence)) {
    const evidence = evidenceOf(entry);
    if (evidence !== undefined) byUrl.set(url, evidence);
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

/** The findings of one comparison, each naming the reference that earned it and its exact place. */
function findingsOf(comparison: ClaimComparison): DriftFinding[] {
  const references = new Map<string, CodeRef>();
  for (const ref of comparison.references) references.set(spanKey(ref.pos), ref);

  const findings: DriftFinding[] = [];
  for (const diagnostic of comparison.diagnostics) {
    const pos = diagnostic.pos;
    if (pos === undefined) continue;
    const ref = references.get(spanKey(pos));
    const reference = ref === undefined ? `${pos.file}:${pos.line}` : referenceOf(ref);
    const target = ref === undefined ? undefined : targetOf(ref, comparison.identity.sources[ref.path]);
    findings.push({
      kind: diagnostic.id,
      reference,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.help === undefined ? {} : { help: diagnostic.help }),
      source: pos,
      ...(target === undefined ? {} : { target }),
    });
  }
  return findings;
}

/** True when two source identities name the same paths with the same hashes or markers. */
function sameSources(
  stored: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): boolean {
  const left = stored ?? {};
  const leftKeys = Object.keys(left).sort(byCodePoint);
  const rightKeys = Object.keys(current).sort(byCodePoint);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((path, index) => path === rightKeys[index] && left[path] === current[path]);
}

/**
 * The state of stored evidence against the current page and files. Content is compared first, so a
 * changed page is stale even when no root lets the sources be read; without a current comparison the
 * sources cannot be confirmed, which is `unavailable`, never `fresh`.
 */
function stateOfStored(
  page: Page,
  stored: DriftEvidence,
  comparison: ClaimComparison | undefined,
): DriftState {
  if (stored.content === undefined) return "unknown";
  if (stored.content !== driftContentOf(page)) return "stale";
  if (comparison === undefined) return "unavailable";
  return sameSources(stored.sources, comparison.identity.sources) ? "fresh" : "stale";
}

/** Evidence for findings measured in this run. */
function freshEvidence(comparison: ClaimComparison): DriftEvidence {
  return {
    version: DRIFT_EVIDENCE_VERSION,
    state: "fresh",
    content: comparison.identity.content,
    sources: comparison.identity.sources,
  };
}

/** Evidence that says only that there is none. */
function unknownEvidence(): DriftEvidence {
  return { version: DRIFT_EVIDENCE_VERSION, state: "unknown" };
}

/** Evidence that carries a state but no measured identity. */
function stateEvidence(state: DriftState): DriftEvidence {
  return { version: DRIFT_EVIDENCE_VERSION, state };
}

/** Stored evidence echoed under the state it was rechecked to, keeping the identity it names. */
function echoEvidence(stored: DriftEvidence, state: DriftState): DriftEvidence {
  return {
    version: DRIFT_EVIDENCE_VERSION,
    state,
    ...(stored.content === undefined ? {} : { content: stored.content }),
    ...(stored.sources === undefined ? {} : { sources: stored.sources }),
  };
}

/** N09's comparisons for the site, or `undefined` when the check could not run at all. */
async function comparisonsOf(
  pages: readonly Page[],
  root: string,
): Promise<readonly ClaimComparison[] | undefined> {
  try {
    return await comparePages(pages, { root });
  } catch {
    // A check that cannot run makes every page's evidence unavailable; it never reads as fresh.
    return undefined;
  }
}

/** Orders two source spans, with an absent span first. */
function compareSpans(a: SourcePos | undefined, b: SourcePos | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return (
    byCodePoint(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

/** Findings by reference, then kind, severity, source span, and message, so two runs agree. */
function compareFindings(a: DriftFinding, b: DriftFinding): number {
  return (
    byCodePoint(a.reference, b.reference) ||
    byCodePoint(a.kind, b.kind) ||
    byCodePoint(a.severity, b.severity) ||
    compareSpans(a.source, b.source) ||
    byCodePoint(a.message ?? "", b.message ?? "")
  );
}

/** The drift check's ordering, per URL: findings by reference through message, with empty pages left out. */
function orderedPages(candidates: Map<string, DriftFinding[]>): Record<string, readonly DriftFinding[]> {
  const pages: Record<string, readonly DriftFinding[]> = {};
  for (const url of [...candidates.keys()].sort(byCodePoint)) {
    const findings = candidates.get(url) ?? [];
    if (findings.length === 0) continue;
    pages[url] = [...findings].sort(compareFindings);
  }
  return pages;
}

/** Evidence by page URL in code-point order. */
function orderedEvidence(candidates: Map<string, DriftEvidence>): Record<string, DriftEvidence> {
  const evidence: Record<string, DriftEvidence> = {};
  for (const url of [...candidates.keys()].sort(byCodePoint)) evidence[url] = candidates.get(url) as DriftEvidence;
  return evidence;
}

/** Coverage by page URL in code-point order. */
function orderedCoverage(candidates: Map<string, DriftPageCoverage>): Record<string, DriftPageCoverage> {
  const coverage: Record<string, DriftPageCoverage> = {};
  for (const url of [...candidates.keys()].sort(byCodePoint)) coverage[url] = candidates.get(url) as DriftPageCoverage;
  return coverage;
}

/**
 * The `drift.json` body: page-keyed findings, per-page coverage, and the evidence behind them. A page in
 * `site.data.drift` (or `options.data`) wins over the computed findings, including an empty list. A
 * stored entry whose evidence no longer matches the current content or files is recomputed when a root
 * is known, and is otherwise kept but marked `stale` or `unavailable`, never fresh. Every doc page gets
 * an evidence and coverage entry, so a page the check could not reach is visibly `unknown` and
 * `checked: false` instead of looking clean.
 */
export async function driftReportOf(
  site: Site,
  options: DriftReportOptions = {},
): Promise<DriftReportBody> {
  const data = options.data ?? site.data.drift;
  const stored = findingsFromData(data);
  const prior = evidenceFromData(data);
  const root = options.root;
  const comparisons = root === undefined ? undefined : await comparisonsOf(site.pages, root);

  const byFile = new Map<string, ClaimComparison>();
  for (const comparison of comparisons ?? []) byFile.set(comparison.file, comparison);

  const candidates = new Map<string, DriftFinding[]>(stored ?? []);
  const evidence = new Map<string, DriftEvidence>();
  const measured = new Set<string>();

  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    measured.add(page.url);
    const comparison = byFile.get(page.source.file);
    // Evidence can only vouch for stored findings: with no usable pages map it must not suppress a fresh check.
    const entry = stored === undefined ? undefined : prior?.get(page.url);

    if (stored?.has(page.url) !== true && entry === undefined) {
      if (comparison === undefined) {
        evidence.set(page.url, stateEvidence(root === undefined ? "unknown" : "unavailable"));
      } else {
        candidates.set(page.url, findingsOf(comparison));
        evidence.set(page.url, freshEvidence(comparison));
      }
      continue;
    }

    if (entry === undefined) {
      // A hand-written entry carries no identity, so it is an override whose evidence is unknown.
      evidence.set(page.url, unknownEvidence());
      continue;
    }

    const state = stateOfStored(page, entry, comparison);
    if (state === "fresh" && comparison !== undefined) {
      evidence.set(page.url, freshEvidence(comparison));
    } else if (comparison !== undefined) {
      // The stored identity no longer matches; this run's comparison is the current evidence.
      candidates.set(page.url, findingsOf(comparison));
      evidence.set(page.url, freshEvidence(comparison));
    } else {
      evidence.set(page.url, echoEvidence(entry, state));
    }
  }

  const coverage = new Map<string, DriftPageCoverage>();
  for (const url of measured) {
    coverage.set(url, {
      checked: evidence.get(url)?.state === "fresh",
      findings: candidates.get(url)?.length ?? 0,
    });
  }
  // A stored entry can name a URL the site model does not hold; give it a count too, never checked.
  for (const [url, findings] of candidates) {
    if (!coverage.has(url)) coverage.set(url, { checked: false, findings: findings.length });
  }

  return {
    pages: orderedPages(candidates),
    coverage: orderedCoverage(coverage),
    evidence: orderedEvidence(evidence),
  };
}

/**
 * The page-keyed findings the report writes, without coverage or evidence. Same rules as
 * {@link driftReportOf}; kept as the narrow shape callers and tests read.
 */
export async function driftPagesOf(
  site: Site,
  options: DriftReportOptions = {},
): Promise<Record<string, readonly DriftFinding[]>> {
  return (await driftReportOf(site, options)).pages;
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
 * Writes `drift.json`: every drift finding per page URL, per-page coverage, and the evidence behind
 * them, sorted, with a fixed key order and a trailing line feed. The file is always written, and a site
 * without findings gets exactly `{ "pages": {} }` under `pages`.
 */
export const driftReport: Output = {
  name: "drift-report",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const body = await driftReportOf(site, { root: driftRoot() });
    return [{ path: "drift.json", contents: `${JSON.stringify(body, null, 2)}\n` }];
  },
};
