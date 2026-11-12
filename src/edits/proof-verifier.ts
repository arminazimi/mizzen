/**
 * Checks every claim an edit proof carries (#60).
 *
 * A proof record ([./proof.ts](./proof.ts)) names each touched file, the SHA-256 of its bytes after the
 * edit, and the resulting source spans with the SHA-256 of the text each covers. This module reads that
 * evidence back: it parses the record, resolves each recorded path to a real path inside the site root,
 * re-hashes the file, and re-slices and re-hashes every recorded span. A span whose text is still in the
 * file but at another position is `moved`; one whose text is nowhere is a wrong hash; one that runs
 * outside the file is a range failure.
 *
 * Locating a move is a bounded search, not a hash per offset: see {@link MovedTextIndex} for the rolling
 * fingerprint, the caps it works under, and the counters that report what one search cost.
 *
 * A path that leaves the root through a symlink is never read: `realpath` is checked against the root
 * first, so a proof cannot be used to hash or leak a file outside the site.
 *
 * The doctor is a separate package, so its report is plain JSON input here. Its contract is
 * `{ "version": 1, "diagnostics": [...] }`; a legacy level-only report is refused rather than compared
 * against a proof level, since the current doctor does not emit one. The record's findings are compared
 * with the report's, field by field, for the fields the record kept.
 *
 * Every file is checked, and the findings come back in path order, so a caller reports all mismatches
 * instead of stopping at the first.
 *
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sliceBySpan } from "./patch.ts";
import {
  PROOF_LEVELS,
  PROOF_VERSION,
  type ProofDoctor,
  type ProofFinding,
  type ProofLevel,
  type ProofSpan,
} from "./proof.ts";

/** Why one recorded claim did not verify. Each code names one check, so callers can tell them apart. */
export type ProofVerifyCode =
  | "verify.proof-invalid"
  | "verify.file.changed"
  | "verify.file.missing"
  | "verify.file.extra"
  | "verify.path.escape"
  | "verify.span.moved"
  | "verify.span.hash"
  | "verify.span.range";

/** One recorded file, reduced to the evidence a check needs. */
export interface ProofFileEvidence {
  /** The file, relative to the site root, with forward slashes. */
  readonly path: string;
  /** SHA-256 of the bytes after the edit, or `null` when the proof records the file deleted. */
  readonly after: string | null;
  /** The resulting source spans, when the record keeps any. */
  readonly spans?: readonly ProofSpan[];
}

/** The parts of a record a verification uses. */
export interface ParsedProof {
  /** Every recorded file, in path order. */
  readonly files: readonly ProofFileEvidence[];
  /** The recorded doctor result, when the record has one. */
  readonly doctor?: ProofDoctor;
}

/** One failed claim: its stable code, the site-relative path, and the span when the proof named one. */
export interface ProofVerifyIssue {
  readonly code: ProofVerifyCode;
  /** The file the issue is about. */
  readonly path: string;
  /** The recorded span, for a span issue. */
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  /** The SHA-256 the proof recorded for the span. */
  readonly hash?: string;
  /** Where a moved span's text was found. */
  readonly foundLine?: number;
  readonly foundColumn?: number;
  readonly foundEndLine?: number;
  readonly foundEndColumn?: number;
}

/** What one recorded file's evidence looks like now. */
export type ProofFileOutcome = "ok" | "changed" | "missing" | "extra" | "escape";

/** One file's check: its outcome, how many spans the proof recorded, and every issue found. */
export interface ProofFileVerification {
  readonly path: string;
  readonly outcome: ProofFileOutcome;
  readonly spans: number;
  readonly issues: readonly ProofVerifyIssue[];
}

/** A proof that cannot be read or does not have the shape the format requires. */
export class ProofReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofReadError";
  }
}

/** A doctor report that is not the diagnostics JSON contract, or one this version cannot read. */
export class DoctorReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorReportError";
  }
}

/** One doctor finding, projected to the fields a proof keeps, so the two can be compared. */
export interface DoctorFinding {
  readonly id: string;
  readonly severity: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/** How recorded findings compare with the doctor's current diagnostics. */
export interface DoctorComparison {
  readonly matched: boolean;
  readonly recorded: number;
  readonly actual: number;
  /** The first difference, when the two do not match. */
  readonly difference?: string;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A hash the record may keep: 64 lowercase hex characters, or `null` for a file absent on that side. */
function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isLevel(value: unknown): value is ProofLevel {
  return value === null || (typeof value === "string" && (PROOF_LEVELS as readonly string[]).includes(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A path that stays inside the site root and uses forward slashes, as the proof schema requires. */
function isProofPath(path: string): boolean {
  if (path === "" || path === "." || path === ".." || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

/** Parses one recorded span, refusing anything that cannot name text. */
function parseSpan(value: unknown): ProofSpan {
  if (!isObject(value)) throw new ProofReadError("a `spans` entry is not an object");
  for (const key of ["line", "column", "endLine", "endColumn"] as const) {
    if (!isPositiveInteger(value[key])) {
      throw new ProofReadError(`a span's ${key} is not a 1-based positive integer`);
    }
  }
  if (!isHash(value.hash)) throw new ProofReadError("a span's hash is not a SHA-256");
  return {
    line: value.line as number,
    column: value.column as number,
    endLine: value.endLine as number,
    endColumn: value.endColumn as number,
    hash: value.hash,
  };
}

/** Parses one recorded doctor finding, refusing anything the record could not have written. */
function parseFinding(value: unknown): ProofFinding {
  if (!isObject(value)) throw new ProofReadError("a doctor finding is not an object");
  if (typeof value.id !== "string" || value.id === "") throw new ProofReadError("a doctor finding has no id");
  if (value.severity !== "error" && value.severity !== "warning" && value.severity !== "info") {
    throw new ProofReadError(`the doctor finding "${value.id}" has an unknown severity`);
  }
  if (typeof value.message !== "string" || value.message === "") {
    throw new ProofReadError(`the doctor finding "${value.id}" has no message`);
  }
  const finding: {
    id: string;
    severity: "error" | "warning" | "info";
    message: string;
    file?: string;
    line?: number;
    column?: number;
  } = { id: value.id, severity: value.severity, message: value.message };
  if (value.file !== undefined) {
    if (typeof value.file !== "string" || !isProofPath(value.file)) {
      throw new ProofReadError(`the doctor finding "${value.id}" names a path outside the site root`);
    }
    finding.file = value.file;
  }
  for (const key of ["line", "column"] as const) {
    const number = value[key];
    if (number === undefined) continue;
    if (!isPositiveInteger(number)) throw new ProofReadError(`the doctor finding "${value.id}" has an invalid ${key}`);
    finding[key] = number;
  }
  return finding;
}

/** Parses the record, refusing anything that is not one complete proof of the current version. */
export function parseProof(text: string): ParsedProof {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProofReadError("it is not JSON");
  }
  if (!isObject(value)) throw new ProofReadError("it is not a JSON object");
  if (value.version !== PROOF_VERSION) {
    throw new ProofReadError(`its version is ${String(value.version)}, not ${PROOF_VERSION}`);
  }
  if (!Array.isArray(value.files)) throw new ProofReadError("`files` is not a list");

  const files: ProofFileEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!isObject(entry)) throw new ProofReadError("a `files` entry is not an object");
    const path = entry.path;
    if (typeof path !== "string" || !isProofPath(path)) {
      throw new ProofReadError(`"${String(path)}" is not a path inside the site root`);
    }
    if (seen.has(path)) throw new ProofReadError(`"${path}" is listed more than once`);
    if (!isHashOrNull(entry.before) || !isHashOrNull(entry.after)) {
      throw new ProofReadError(`"${path}" does not have a before and an after hash`);
    }
    seen.add(path);

    let spans: ProofSpan[] | undefined;
    if (entry.spans !== undefined) {
      if (!Array.isArray(entry.spans)) throw new ProofReadError(`"${path}" spans is not a list`);
      spans = entry.spans.map(parseSpan).sort(bySpan);
    }
    files.push({ path, after: entry.after, ...(spans === undefined ? {} : { spans }) });
  }
  files.sort((a, b) => byCodePoint(a.path, b.path));

  if (value.doctor === undefined) return { files };
  if (!isObject(value.doctor)) throw new ProofReadError("`doctor` is not an object");
  if (!isLevel(value.doctor.level)) {
    throw new ProofReadError(`the doctor level ${String(value.doctor.level)} is not one of L0, L1, L2, L3, or null`);
  }
  const doctor: { level: ProofLevel; findings?: readonly ProofFinding[] } = { level: value.doctor.level };
  if (value.doctor.findings !== undefined) {
    if (!Array.isArray(value.doctor.findings)) throw new ProofReadError("`doctor.findings` is not a list");
    doctor.findings = value.doctor.findings.map(parseFinding);
  }
  return { files, doctor };
}

/** Compares two proof spans by position, never by locale. */
function bySpan(a: ProofSpan, b: ProofSpan): number {
  return a.line - b.line || a.column - b.column || a.endLine - b.endLine || a.endColumn - b.endColumn;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of the text as UTF-8, matching how the proof writer hashed a span. */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Resolves the site root to a real path; a root that does not exist keeps its lexical path. */
async function realRootOf(siteRoot: string): Promise<string> {
  try {
    return await realpath(siteRoot);
  } catch {
    return resolve(siteRoot);
  }
}

/** True when `target` is a real path strictly inside the real `root`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolves a record path under the site root, with forward slashes split for the platform. */
function fileAt(siteRoot: string, path: string): string {
  return join(siteRoot, ...path.split("/"));
}

// A moved span is located by a bounded rolling search over the file's code points: every window of
// the recorded length gets one cheap 52-bit fingerprint, and a full SHA-256 is computed only for a
// window whose text has not been seen before under that fingerprint. Repeated text therefore costs
// one confirmation instead of one hash per offset, so a long span in a large changed file no longer
// means quadratic hashing. The fingerprint is only a candidate key: a window is skipped as a
// duplicate only after its code points are compared with the windows already seen under that key, so
// two different texts sharing a fingerprint cost the second one a confirmation, never its match. The
// map stores offsets, not text, so its size stays bounded by the scan.
// shortcut: a search that reaches one of these caps reports a hash mismatch instead of a move, the
// same honest fallback a span outside the caps has always had. Raise them if larger spans must be
// located.
export const MOVED_SCAN_CODE_POINTS = 2_000_000;
export const MOVED_SPAN_CODE_POINTS = 100_000;
export const MOVED_CANDIDATE_CONFIRMATIONS = 262_144;
export const MOVED_CANDIDATE_CODE_POINTS = 16_777_216;

/** The caps one moved-span search works under; every field defaults to the documented constant. */
export interface MovedSearchLimits {
  /** Largest file, in code points, whose text is searched at all. */
  readonly maxScanCodePoints?: number;
  /** Largest span, in code points, that is searched. */
  readonly maxSpanCodePoints?: number;
  /** Largest number of full SHA-256 confirmations one search makes. */
  readonly maxCandidateConfirmations?: number;
  /** Largest number of code points one search hands to SHA-256 in total. */
  readonly maxCandidateCodePoints?: number;
}

/** The cap that stopped a search, so a caller can tell an honest fallback from a real absence. */
export type MovedSearchCap = "span-length" | "scan-size" | "confirmations" | "candidate-code-points";

/** How one moved-span search ended. */
export type MovedSearchOutcome = "found" | "absent" | "capped";

/** Where the searched text sits, in the same inclusive line and column units as a recorded span. */
export interface MovedPosition {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** One moved-span search and the work it cost, so a caller can see that the search stayed bounded. */
export interface MovedSearchResult {
  readonly outcome: MovedSearchOutcome;
  /** Where the text was found, when `outcome` is `found`. */
  readonly position?: MovedPosition;
  /** The cap that stopped the search, when `outcome` is `capped`. */
  readonly cap?: MovedSearchCap;
  /** Window offsets fingerprinted by the rolling search: never more than one per code point. */
  readonly scannedOffsets: number;
  /** Full SHA-256 computations: one per distinct candidate, never one per offset. */
  readonly confirmations: number;
  /** Code points handed to SHA-256 in total. */
  readonly candidateCodePoints: number;
}

/** One search a file check ran, with the span that asked for it, for {@link MovedSearchOptions.onSearch}. */
export interface MovedSearchObservation {
  /** The recorded span whose text was searched for. */
  readonly span: ProofSpan;
  /** The file's size in code points, which is what the scan cap measures. */
  readonly codePoints: number;
  /** How many line-start tables the file's index has built: one, however many spans move. */
  readonly lineIndexBuilds: number;
  /** How the search ended and what it cost. */
  readonly result: MovedSearchResult;
}

/** How one file check is allowed to look for moved text: the caps it works under and a work observer. */
export interface MovedSearchOptions extends MovedSearchLimits {
  /**
   * Called once for every moved-span search the file check runs, with the work it did.
   *
   * A caller that must bound its own effort passes lower caps, and any caller can count the
   * confirmations the check actually made; the reported numbers are the search's own counters.
   */
  readonly onSearch?: (observation: MovedSearchObservation) => void;
}

/** The two moduli and bases of the rolling fingerprint, kept under 2^26 so its products stay exact. */
const FINGERPRINT_MODULUS_A = 67_108_859;
const FINGERPRINT_MODULUS_B = 67_108_823;
const FINGERPRINT_BASE_A = 1_000_003;
const FINGERPRINT_BASE_B = 999_983;
/** Above both moduli, so `(fingerprintA * KEY_STRIDE) + fingerprintB` is one exact integer key. */
const FINGERPRINT_KEY_STRIDE = 67_108_864;

/** Code-point values, one per entry, and the UTF-16 offset of each, exactly as `Array.from` splits. */
function codePointArrays(text: string, count: number): { points: Uint32Array; units: Uint32Array; written: number } {
  const points = new Uint32Array(count);
  const units = new Uint32Array(count + 1);
  let at = 0;
  for (let unit = 0; unit < text.length; ) {
    const lead = text.charCodeAt(unit);
    let value = lead;
    let width = 1;
    if (lead >= 0xd800 && lead <= 0xdbff && unit + 1 < text.length) {
      const trail = text.charCodeAt(unit + 1);
      if (trail >= 0xdc00 && trail <= 0xdfff) {
        value = 0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00);
        width = 2;
      }
    }
    points[at] = value;
    units[at] = unit;
    at += 1;
    unit += width;
  }
  units[at] = text.length;
  return { points, units, written: at };
}

/** How many code points `text` holds, counting a surrogate pair as one and a lone surrogate as one. */
function countCodePoints(text: string): number {
  let pairs = 0;
  for (let unit = 0; unit + 1 < text.length; unit += 1) {
    const lead = text.charCodeAt(unit);
    const trail = text.charCodeAt(unit + 1);
    if (lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff) {
      pairs += 1;
      unit += 1;
    }
  }
  return text.length - pairs;
}

/**
 * The code-point offset each line starts at: `starts[k]` is the first code point of line `k + 1`.
 *
 * A line ends at a line feed, which counts as a column of the line it closes, exactly as the recorded
 * spans measure a CRLF file.
 */
function lineStartsOf(points: Uint32Array): Uint32Array {
  let lines = 1;
  for (let at = 0; at < points.length; at += 1) {
    if (points[at] === 10) lines += 1;
  }
  const starts = new Uint32Array(lines);
  starts[0] = 0;
  let line = 1;
  for (let at = 0; at < points.length; at += 1) {
    if (points[at] === 10) {
      starts[line] = at + 1;
      line += 1;
    }
  }
  return starts;
}

/** The 1-based line and column of a code-point offset, read off the precomputed line starts. */
function positionOf(starts: Uint32Array, index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((starts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - (starts[low] ?? 0) + 1 };
}

/**
 * The code points of one file's text, indexed once so every moved-span search reads that index.
 *
 * The search a {@link MovedTextIndex.search} runs is linear in the file: one rolling fingerprint per
 * window and one full SHA-256 per distinct candidate, with the position of a match read from the
 * precomputed line starts instead of a rescan of the prefix.
 */
export class MovedTextIndex {
  private readonly text: string;
  private readonly count: number;
  private points: Uint32Array | undefined;
  private units: Uint32Array | undefined;
  private starts: Uint32Array | undefined;
  private builds = 0;
  private lookups = 0;

  constructor(text: string) {
    this.text = text;
    this.count = countCodePoints(text);
  }

  /** The text's length in code points, which is all the caps need before a search is run. */
  get codePoints(): number {
    return this.count;
  }

  /** How many times the line-start table was built: one index builds it once, however many spans move. */
  get lineIndexBuilds(): number {
    return this.builds;
  }

  /** How many match positions were read off that table instead of rescanning the prefix. */
  get positionsResolved(): number {
    return this.lookups;
  }

  /** Where else in the text `length` code points hashing to `hash` sit, and what locating them cost. */
  search(length: number, hash: string, limits: MovedSearchLimits = {}): MovedSearchResult {
    const maxScan = limits.maxScanCodePoints ?? MOVED_SCAN_CODE_POINTS;
    const maxSpan = limits.maxSpanCodePoints ?? MOVED_SPAN_CODE_POINTS;
    const maxConfirmations = limits.maxCandidateConfirmations ?? MOVED_CANDIDATE_CONFIRMATIONS;
    const maxCandidatePoints = limits.maxCandidateCodePoints ?? MOVED_CANDIDATE_CODE_POINTS;

    if (length < 1 || length > maxSpan) return noWork("capped", "span-length");
    if (this.count > maxScan) return noWork("capped", "scan-size");

    const points = this.indexPoints();
    if (length > points.length) return noWork("absent");
    const units = this.indexUnits();

    let fingerprintA = 0;
    let fingerprintB = 0;
    let leadA = 1;
    let leadB = 1;
    for (let at = 0; at < length; at += 1) {
      const value = points[at] ?? 0;
      fingerprintA = (fingerprintA * FINGERPRINT_BASE_A + value) % FINGERPRINT_MODULUS_A;
      fingerprintB = (fingerprintB * FINGERPRINT_BASE_B + value) % FINGERPRINT_MODULUS_B;
      if (at > 0) {
        leadA = (leadA * FINGERPRINT_BASE_A) % FINGERPRINT_MODULUS_A;
        leadB = (leadB * FINGERPRINT_BASE_B) % FINGERPRINT_MODULUS_B;
      }
    }

    // Fingerprint key to the offsets already confirmed under it. One offset for the common case, a
    // list only when two different windows collide on the same fingerprint.
    const seen = new Map<number, number | number[]>();
    let confirmations = 0;
    let candidateCodePoints = 0;
    const windows = points.length - length + 1;
    let scannedOffsets = 0;

    for (let start = 0; start < windows; start += 1) {
      if (start > 0) {
        const outgoing = points[start - 1] ?? 0;
        const incoming = points[start + length - 1] ?? 0;
        fingerprintA = fingerprintA - ((outgoing * leadA) % FINGERPRINT_MODULUS_A);
        if (fingerprintA < 0) fingerprintA += FINGERPRINT_MODULUS_A;
        fingerprintA = (fingerprintA * FINGERPRINT_BASE_A + incoming) % FINGERPRINT_MODULUS_A;
        fingerprintB = fingerprintB - ((outgoing * leadB) % FINGERPRINT_MODULUS_B);
        if (fingerprintB < 0) fingerprintB += FINGERPRINT_MODULUS_B;
        fingerprintB = (fingerprintB * FINGERPRINT_BASE_B + incoming) % FINGERPRINT_MODULUS_B;
      }
      scannedOffsets = start + 1;

      const key = fingerprintA * FINGERPRINT_KEY_STRIDE + fingerprintB;
      const known = seen.get(key);
      if (known !== undefined) {
        const duplicate =
          typeof known === "number"
            ? this.sameWindow(start, known, length)
            : known.some((other) => this.sameWindow(start, other, length));
        if (duplicate) continue;
      }
      if (confirmations >= maxConfirmations) {
        return { outcome: "capped", cap: "confirmations", scannedOffsets, confirmations, candidateCodePoints };
      }
      if (candidateCodePoints + length > maxCandidatePoints) {
        return {
          outcome: "capped",
          cap: "candidate-code-points",
          scannedOffsets,
          confirmations,
          candidateCodePoints,
        };
      }
      if (known === undefined) seen.set(key, start);
      else if (typeof known === "number") seen.set(key, [known, start]);
      else known.push(start);
      confirmations += 1;
      candidateCodePoints += length;

      if (hashText(this.text.slice(units[start] ?? 0, units[start + length] ?? 0)) !== hash) continue;
      const starts = this.indexStarts();
      const first = positionOf(starts, start);
      const last = positionOf(starts, start + length - 1);
      this.lookups += 1;
      return {
        outcome: "found",
        position: { line: first.line, column: first.column, endLine: last.line, endColumn: last.column },
        scannedOffsets,
        confirmations,
        candidateCodePoints,
      };
    }
    return { outcome: "absent", scannedOffsets, confirmations, candidateCodePoints };
  }

  /** True when the windows starting at `a` and `b` hold the same `length` code points. */
  private sameWindow(a: number, b: number, length: number): boolean {
    const points = this.indexPoints();
    const units = this.indexUnits();
    const left = units[a] ?? 0;
    const right = units[b] ?? 0;
    for (let at = 0; at < length; at += 1) {
      if (points[left + at] !== points[right + at]) return false;
    }
    return true;
  }

  /** The code-point values of the text, built once and reused by every search over this file. */
  private indexPoints(): Uint32Array {
    if (this.points === undefined) this.build();
    return this.points as Uint32Array;
  }

  private indexUnits(): Uint32Array {
    if (this.units === undefined) this.build();
    return this.units as Uint32Array;
  }

  private indexStarts(): Uint32Array {
    if (this.starts === undefined) {
      this.starts = lineStartsOf(this.indexPoints());
      this.builds += 1;
    }
    return this.starts;
  }

  private build(): void {
    const arrays = codePointArrays(this.text, this.count);
    // The counted length is the truth the caps compare against; a shorter array means the count was
    // wrong, so the search keeps the entries that actually exist rather than reading padded zeroes.
    this.points = arrays.points.subarray(0, arrays.written);
    this.units = arrays.units.subarray(0, arrays.written + 1);
  }
}

/** A search that never ran, or never could: it costs no scanning and no confirmation. */
function noWork(outcome: MovedSearchOutcome, cap?: MovedSearchCap): MovedSearchResult {
  return cap === undefined
    ? { outcome, scannedOffsets: 0, confirmations: 0, candidateCodePoints: 0 }
    : { outcome, cap, scannedOffsets: 0, confirmations: 0, candidateCodePoints: 0 };
}

/** Every span issue for one file whose after hash still matches. */
function spanIssues(
  path: string,
  text: string,
  spans: readonly ProofSpan[],
  movedSearch: MovedSearchOptions,
): ProofVerifyIssue[] {
  const issues: ProofVerifyIssue[] = [];
  // One index per file: its code points and line starts are read by every span's search, never rebuilt.
  let index: MovedTextIndex | undefined;
  for (const span of [...spans].sort(bySpan)) {
    let slice: string;
    try {
      slice = sliceBySpan(text, span);
    } catch {
      issues.push({ code: "verify.span.range", path, line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn, hash: span.hash });
      continue;
    }
    if (slice === "") {
      issues.push({ code: "verify.span.range", path, line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn, hash: span.hash });
      continue;
    }
    if (hashText(slice) === span.hash) continue;

    index ??= new MovedTextIndex(text);
    const moved = index.search(Array.from(slice).length, span.hash, movedSearch);
    movedSearch.onSearch?.({ span, codePoints: index.codePoints, lineIndexBuilds: index.lineIndexBuilds, result: moved });
    const position = moved.position;
    if (position !== undefined) {
      issues.push({
        code: "verify.span.moved",
        path,
        line: span.line,
        column: span.column,
        endLine: span.endLine,
        endColumn: span.endColumn,
        hash: span.hash,
        foundLine: position.line,
        foundColumn: position.column,
        foundEndLine: position.endLine,
        foundEndColumn: position.endColumn,
      });
      continue;
    }
    issues.push({ code: "verify.span.hash", path, line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn, hash: span.hash });
  }
  return issues;
}

/**
 * Checks every recorded file against the working tree under `siteRoot`, in path order.
 *
 * A file is never read through a path whose real target leaves the site root: that is `escape`. A file
 * that is readable but hashes differently is `changed`; its spans are not checked, because they were
 * positions in text that is no longer there. Every other file is checked down to each recorded span.
 *
 * `movedSearch` bounds and observes the search for moved text; omitted, it works under the documented
 * caps, and a span beyond one of them reports `verify.span.hash` rather than a move.
 */
export async function verifyProofFiles(
  siteRoot: string,
  files: readonly ProofFileEvidence[],
  movedSearch: MovedSearchOptions = {},
): Promise<readonly ProofFileVerification[]> {
  const root = await realRootOf(siteRoot);
  const results: ProofFileVerification[] = [];

  for (const entry of [...files].sort((a, b) => byCodePoint(a.path, b.path))) {
    const target = fileAt(siteRoot, entry.path);
    const spanCount = entry.spans?.length ?? 0;

    let real: string | undefined;
    try {
      real = await realpath(target);
    } catch {
      // A path that does not resolve cannot be read; the read below says whether it is missing.
    }
    if (real !== undefined && !isInside(root, real)) {
      results.push({
        path: entry.path,
        outcome: "escape",
        spans: spanCount,
        issues: [{ code: "verify.path.escape", path: entry.path }],
      });
      continue;
    }

    let bytes: Buffer | undefined;
    let readError: NodeJS.ErrnoException | undefined;
    try {
      // Read the resolved path, never the recorded path again, so a symlink swapped after the check
      // cannot redirect the read outside the root.
      bytes = await readFile(real ?? target);
    } catch (err) {
      readError = err as NodeJS.ErrnoException;
    }
    const absent = readError !== undefined && (readError.code === "ENOENT" || readError.code === "ENOTDIR");

    if (entry.after === null) {
      if (absent) {
        results.push({ path: entry.path, outcome: "ok", spans: spanCount, issues: [] });
        continue;
      }
      results.push({
        path: entry.path,
        outcome: "extra",
        spans: spanCount,
        issues: [{ code: "verify.file.extra", path: entry.path }],
      });
      continue;
    }

    if (bytes === undefined) {
      const outcome = absent ? "missing" : "changed";
      results.push({
        path: entry.path,
        outcome,
        spans: spanCount,
        issues: [{ code: absent ? "verify.file.missing" : "verify.file.changed", path: entry.path }],
      });
      continue;
    }

    if (hashBytes(bytes) !== entry.after) {
      results.push({
        path: entry.path,
        outcome: "changed",
        spans: spanCount,
        issues: [{ code: "verify.file.changed", path: entry.path }],
      });
      continue;
    }

    const issues = spanIssues(entry.path, bytes.toString("utf8"), entry.spans ?? [], movedSearch);
    results.push({ path: entry.path, outcome: "ok", spans: spanCount, issues });
  }

  return results;
}

/** Reads one doctor diagnostic as the projection a proof keeps, refusing a malformed report. */
function projectDiagnostic(value: unknown): DoctorFinding {
  if (!isObject(value)) throw new DoctorReportError("a diagnostic is not an object");
  if (typeof value.id !== "string" || value.id === "") throw new DoctorReportError("a diagnostic has no id");
  if (value.severity !== "error" && value.severity !== "warning" && value.severity !== "info") {
    throw new DoctorReportError(`the diagnostic "${value.id}" has an unknown severity`);
  }
  if (typeof value.message !== "string") throw new DoctorReportError(`the diagnostic "${value.id}" has no message`);

  const finding: {
    id: string;
    severity: string;
    message: string;
    file?: string;
    line?: number;
    column?: number;
  } = { id: value.id, severity: value.severity, message: value.message };
  if (value.pos !== undefined) {
    if (!isObject(value.pos) || typeof value.pos.file !== "string") {
      throw new DoctorReportError(`the diagnostic "${value.id}" has a malformed position`);
    }
    finding.file = value.pos.file;
    if (value.pos.line !== undefined) {
      if (!isPositiveInteger(value.pos.line)) throw new DoctorReportError(`the diagnostic "${value.id}" has an invalid line`);
      finding.line = value.pos.line;
    }
    if (value.pos.column !== undefined) {
      if (!isPositiveInteger(value.pos.column)) {
        throw new DoctorReportError(`the diagnostic "${value.id}" has an invalid column`);
      }
      finding.column = value.pos.column;
    }
  }
  return finding;
}

/**
 * Reads the doctor's `--format json` output: `{ "version": 1, "diagnostics": [...] }`.
 *
 * A level-only report, another version, or any other shape is refused, so a legacy report can never be
 * mistaken for evidence that matches.
 */
export function parseDoctorReport(text: string): readonly DoctorFinding[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DoctorReportError("its output is not JSON");
  }
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.diagnostics)) {
    throw new DoctorReportError("its output is not the version 1 diagnostics report");
  }
  return value.diagnostics.map(projectDiagnostic);
}

/** A finding as one short phrase for a difference sentence. */
function describeFinding(finding: DoctorFinding | ProofFinding): string {
  const where =
    finding.file === undefined
      ? ""
      : ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}${finding.column === undefined ? "" : `:${finding.column}`}`;
  return `"${finding.id}"${where}`;
}

/** True when every field the record kept agrees with the doctor's diagnostic. */
function findingMatches(recorded: ProofFinding, actual: DoctorFinding): boolean {
  if (recorded.id !== actual.id || recorded.severity !== actual.severity || recorded.message !== actual.message) {
    return false;
  }
  if (recorded.file !== undefined && recorded.file !== actual.file) return false;
  if (recorded.line !== undefined && recorded.line !== actual.line) return false;
  if (recorded.column !== undefined && recorded.column !== actual.column) return false;
  return true;
}

/**
 * Compares the findings a proof recorded with the doctor's current diagnostics.
 *
 * Every recorded finding must have one current diagnostic matching the fields the record kept, and every
 * current diagnostic must be accounted for by a recorded finding. A partial projection therefore still
 * matches; a missing, extra, or changed finding does not. The first difference in record order is named.
 */
export function compareDoctorFindings(
  recorded: readonly ProofFinding[],
  actual: readonly DoctorFinding[],
): DoctorComparison {
  const used = new Set<number>();
  for (const finding of recorded) {
    const index = actual.findIndex((candidate, at) => !used.has(at) && findingMatches(finding, candidate));
    if (index < 0) {
      return {
        matched: false,
        recorded: recorded.length,
        actual: actual.length,
        difference: `the recorded finding ${describeFinding(finding)} is not in the doctor report`,
      };
    }
    used.add(index);
  }
  const extra = actual.findIndex((_candidate, at) => !used.has(at));
  if (extra >= 0) {
    return {
      matched: false,
      recorded: recorded.length,
      actual: actual.length,
      difference: `the doctor reports ${describeFinding(actual[extra]!)}, which the proof does not record`,
    };
  }
  return { matched: true, recorded: recorded.length, actual: actual.length };
}
