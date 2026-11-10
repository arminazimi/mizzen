/**
 * A proof record for one agent edit (#1508, N29).
 *
 * An edit is reviewable only when the reviewer can see what the files held before it, what they
 * hold after it, and how the checks that follow an edit ended. This module writes that record as
 * one JSON file: every touched path relative to the site root (and so repository-relative when the
 * site is the repository), the SHA-256 of its bytes before and after, the doctor level (and,
 * optionally, a short projection of its findings), and a summary of the examples an edit re-ran.
 *
 * Two rules keep the record reproducible:
 *
 * - **No wall clock.** The record has no timestamp unless the caller passes `date`, or
 *   `SOURCE_DATE_EPOCH` is set. `SOURCE_DATE_EPOCH` is the reproducible-build convention already
 *   used by `tools/deterministic`: decimal seconds since the Unix epoch. When neither is present,
 *   the `date` field is left out. This module never calls `Date.now()`.
 * - **Fixed order.** Record keys are written in one fixed order, `files` is sorted by path
 *   comparing code points, and `examples.rerun` is sorted and has no duplicates. The same input
 *   therefore gives the same bytes.
 *
 * A file that did not exist before the edit, or does not exist after it, is represented by an
 * explicit `null` hash: `{ "path": "docs/new.md", "before": null, "after": "<hash>" }` is an added
 * file, and the reverse is a deleted one. An absent key is never guessed at; {@link createProof}
 * refuses a `files` entry missing from `before` or `after`.
 *
 * The record is written atomically: the new bytes go to a fresh folder beside the target and one
 * rename puts them in place, so a reader never sees half a record and a failed write leaves the
 * previous record untouched.
 *
 * This module knows nothing about `packages/doctor`: the doctor's report is accepted as plain
 * input ({@link ProofDoctor}), and only the fields the record keeps are copied. The record's JSON
 * Schema is exported as {@link proofSchema} so a caller or a test can validate what it wrote.
 *
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The proof format version. Only 1 exists. */
export const PROOF_VERSION = 1;

/** The levels `mizzen doctor` reports, in order. `null` means an L0 MUST failed. */
export const PROOF_LEVELS = ["L0", "L1", "L2", "L3"] as const;

/** A doctor level: one of {@link PROOF_LEVELS}, or `null` when the doctor reached none. */
export type ProofLevel = (typeof PROOF_LEVELS)[number] | null;

/** The bytes of a file before or after an edit, or `null` when the file did not exist then. */
export type ProofContent = string | Uint8Array | null;

/** One file's entry in the record. A `null` hash means the file was absent on that side of the edit. */
export interface ProofFile {
  /** The file, relative to the site root, with forward slashes. */
  readonly path: string;
  /** SHA-256 of the file's bytes before the edit, or `null` when the file did not exist then. */
  readonly before: string | null;
  /** SHA-256 of the file's bytes after the edit, or `null` when the file does not exist now. */
  readonly after: string | null;
}

/**
 * One doctor finding, projected to what the record keeps. The doctor's own report has more fields
 * (its `in` folder, allowed values, a fix); a caller copies the fields it wants rather than this
 * module importing the doctor's types.
 */
export interface ProofFinding {
  /** The spec test or generator check the finding belongs to. */
  readonly id: string;
  /** `error` for a failed MUST, `warning` for a SHOULD or a generator check. */
  readonly severity: "error" | "warning";
  /** What is wrong, without the file and line. */
  readonly message: string;
  /** The file the finding is about, relative to the site root, with forward slashes. */
  readonly file?: string;
  /** The line, 1-based, front matter included. */
  readonly line?: number;
  /** The column, 1-based. */
  readonly column?: number;
}

/** The doctor result recorded for an edit: the level it reached and, optionally, its findings. */
export interface ProofDoctor {
  /** The highest level whose MUST tests all passed, or `null` when an L0 MUST failed. */
  readonly level: ProofLevel;
  /** The findings to keep, in the doctor's order. Omitted from the record when not given. */
  readonly findings?: readonly ProofFinding[];
}

/** A summary of the examples an edit re-ran, and how they ended. */
export interface ProofExamples {
  /** Identifiers of the examples that were re-run. The record sorts and de-duplicates them. */
  readonly rerun: readonly string[];
  /** How many of the re-run examples passed. */
  readonly passed: number;
  /** How many of the re-run examples failed. */
  readonly failed: number;
  /** How many were skipped. Omitted means zero and the field is left out. */
  readonly skipped?: number;
}

/** The record as written to disk. */
export interface ProofRecord {
  /** The format version, always {@link PROOF_VERSION}. */
  readonly version: typeof PROOF_VERSION;
  /**
   * When the edit happened, ISO 8601 UTC. Present only when the caller passed `date` or
   * `SOURCE_DATE_EPOCH` was set; the module never reads the wall clock.
   */
  readonly date?: string;
  /** Every touched file, sorted by path comparing code points. */
  readonly files: readonly ProofFile[];
  /** The doctor result, when the edit ran one. */
  readonly doctor?: ProofDoctor;
  /** The examples that were re-run, when the edit ran any. */
  readonly examples?: ProofExamples;
}

/** What {@link createProof} needs. Everything but the paths and the two contents is optional. */
export interface ProofInput {
  /**
   * The site root: the base every recorded path is relative to, and what a relative `out` is
   * resolved against. It is never read; a path is only checked against it.
   */
  readonly siteRoot: string;
  /**
   * The touched files. An entry may be relative to `siteRoot` or absolute inside it; the record
   * keeps it relative, with forward slashes. Duplicates are refused.
   */
  readonly files: readonly string[];
  /**
   * The contents before the edit, keyed by the same strings as `files`. `null` means the file did
   * not exist. A string is hashed as UTF-8; a `Uint8Array` as its bytes.
   */
  readonly before: Readonly<Record<string, ProofContent>>;
  /** The contents after the edit, keyed the same way. `null` means the file no longer exists. */
  readonly after: Readonly<Record<string, ProofContent>>;
  /** The doctor result, when one ran. */
  readonly doctor?: ProofDoctor;
  /** The examples the edit re-ran. */
  readonly examples?: ProofExamples;
  /**
   * The edit's date, as an ISO 8601 string or a `Date`. Default: `SOURCE_DATE_EPOCH` when the
   * environment sets it, else no `date` field. An explicit date always wins.
   */
  readonly date?: string | Date;
}

/** What {@link writeProof} needs: a {@link ProofInput} and where the record goes. */
export interface WriteProofOptions extends ProofInput {
  /**
   * The record's path. A relative path is resolved against `siteRoot`; an absolute one is used as
   * it is. Parent folders are created.
   */
  readonly out: string;
}

/** Why a proof record was refused. Each code names one check so a caller can tell them apart. */
export type ProofErrorCode =
  | "invalid-path"
  | "duplicate-path"
  | "missing-content"
  | "invalid-content"
  | "invalid-date"
  | "invalid-doctor"
  | "invalid-examples";

/** A refused proof record. `createProof` throws it before anything is written. */
export class ProofError extends Error {
  readonly code: ProofErrorCode;

  constructor(code: ProofErrorCode, message: string) {
    super(message);
    this.name = "ProofError";
    this.code = code;
  }
}

/**
 * The record's JSON Schema, draft 2020-12. It is embedded here because a proof record is one small
 * file, not a build output with a schema in `packages/engine/schema/`; tests compile it with ajv
 * and check what {@link writeProof} wrote.
 */
export const proofSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Mizzen edit proof record",
  description:
    "One agent edit's proof: SHA-256 before and after for every touched file, the doctor level, and the examples re-run. No wall-clock timestamp; `date` is present only when the caller or SOURCE_DATE_EPOCH supplied one.",
  type: "object",
  required: ["files", "version"],
  properties: {
    date: {
      type: "string",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
      description: "When the edit happened, ISO 8601 UTC. Omitted when neither the caller nor SOURCE_DATE_EPOCH supplied a date.",
    },
    doctor: { $ref: "#/$defs/doctor" },
    examples: { $ref: "#/$defs/examples" },
    files: {
      type: "array",
      description: "Every touched file, sorted by path comparing code points.",
      items: { $ref: "#/$defs/file" },
    },
    version: {
      const: PROOF_VERSION,
      description: "The format version. Only 1 exists.",
    },
  },
  additionalProperties: false,
  $defs: {
    doctor: {
      type: "object",
      description: "The doctor result: the highest level reached and, when given, a projection of its findings.",
      required: ["level"],
      properties: {
        findings: {
          type: "array",
          description: "The findings kept for the record, in the doctor's order.",
          items: { $ref: "#/$defs/finding" },
        },
        level: {
          enum: [...PROOF_LEVELS, null],
          description: "The highest level whose MUST tests all passed, or null when an L0 MUST failed.",
        },
      },
      additionalProperties: false,
    },
    examples: {
      type: "object",
      description: "A summary of the examples an edit re-ran, and how they ended.",
      required: ["failed", "passed", "rerun"],
      properties: {
        failed: { type: "integer", minimum: 0, description: "How many of the re-run examples failed." },
        passed: { type: "integer", minimum: 0, description: "How many of the re-run examples passed." },
        rerun: {
          type: "array",
          description: "Identifiers of the re-run examples, sorted comparing code points and without duplicates.",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
        skipped: { type: "integer", minimum: 0, description: "How many were skipped. Omitted means zero." },
      },
      additionalProperties: false,
    },
    file: {
      type: "object",
      description: "One touched file and the SHA-256 of its bytes on each side of the edit. A null hash means the file was absent on that side.",
      required: ["after", "before", "path"],
      properties: {
        after: {
          anyOf: [{ $ref: "#/$defs/hash" }, { type: "null" }],
          description: "SHA-256 after the edit, or null when the file does not exist now.",
        },
        before: {
          anyOf: [{ $ref: "#/$defs/hash" }, { type: "null" }],
          description: "SHA-256 before the edit, or null when the file did not exist then.",
        },
        path: { $ref: "#/$defs/path" },
      },
      additionalProperties: false,
    },
    finding: {
      type: "object",
      description: "One doctor finding, projected to the fields the record keeps.",
      required: ["id", "message", "severity"],
      properties: {
        column: { type: "integer", minimum: 1, description: "The column, 1-based." },
        file: {
          $ref: "#/$defs/path",
          description: "The file the finding is about, relative to the site root, with forward slashes.",
        },
        id: { type: "string", minLength: 1, description: "The spec test or generator check the finding belongs to." },
        line: { type: "integer", minimum: 1, description: "The line, 1-based, front matter included." },
        message: { type: "string", minLength: 1, description: "What is wrong, without the file and line." },
        severity: {
          enum: ["error", "warning"],
          description: "error for a failed MUST, warning for a SHOULD or a generator check.",
        },
      },
      additionalProperties: false,
    },
    hash: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description: "SHA-256 of the bytes, as 64 lowercase hexadecimal characters.",
    },
    path: {
      type: "string",
      minLength: 1,
      not: { pattern: "^([a-zA-Z]:)?[\\\\/]|(^|/)\\.\\.(/|$)|\\\\" },
      description: "A relative path with forward slashes: no leading slash, drive letter, backslash, or `..` segment.",
    },
  },
};

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. A string is hashed as UTF-8. */
function hashOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The record's form of a path: relative to `siteRoot`, forward slashes, no way out of the root. */
function recordPath(siteRoot: string, file: string): string {
  const candidate = isAbsolute(file) ? relative(resolve(siteRoot), file) : file;
  const path = candidate.split(sep).join("/");
  if (
    path === "" ||
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new ProofError(
      "invalid-path",
      `proof: "${file}" is not a file relative to the site root; use a relative path with forward slashes and no ".." segment.`,
    );
  }
  return path;
}

/** A content map's value for `file`, refusing a missing or wrongly typed entry. */
function contentOf(
  map: Readonly<Record<string, ProofContent>>,
  file: string,
  side: "before" | "after",
): ProofContent {
  if (!Object.prototype.hasOwnProperty.call(map, file)) {
    throw new ProofError(
      "missing-content",
      `proof: "${file}" is in files but not in ${side}; use null when the file did not exist on that side.`,
    );
  }
  const content = map[file];
  if (content === null || typeof content === "string" || content instanceof Uint8Array) return content;
  throw new ProofError(
    "invalid-content",
    `proof: "${file}" in ${side} is not a string, a Uint8Array, or null.`,
  );
}

/** An ISO 8601 UTC date, from the caller's date or the epoch. Never the wall clock. */
function recordDate(input: ProofInput): string | undefined {
  if (input.date !== undefined) {
    const date = input.date instanceof Date ? input.date : new Date(input.date);
    if (Number.isNaN(date.getTime())) {
      throw new ProofError("invalid-date", `proof: "${String(input.date)}" is not a date.`);
    }
    return date.toISOString();
  }

  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === "") return undefined;
  if (!/^[0-9]+$/.test(epoch)) {
    throw new ProofError(
      "invalid-date",
      `proof: SOURCE_DATE_EPOCH is "${epoch}"; expected whole seconds since the Unix epoch.`,
    );
  }
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds)) {
    throw new ProofError("invalid-date", `proof: SOURCE_DATE_EPOCH is "${epoch}", which is too large.`);
  }
  return new Date(seconds * 1000).toISOString();
}

/** A finding with only the kept fields, in a fixed key order. */
function findingRecord(finding: ProofFinding, siteRoot: string): ProofFinding {
  if (typeof finding.id !== "string" || finding.id === "") {
    throw new ProofError("invalid-doctor", "proof: a doctor finding has no id.");
  }
  if (finding.severity !== "error" && finding.severity !== "warning") {
    throw new ProofError("invalid-doctor", `proof: finding "${finding.id}" has an unknown severity.`);
  }
  if (typeof finding.message !== "string" || finding.message === "") {
    throw new ProofError("invalid-doctor", `proof: finding "${finding.id}" has no message.`);
  }

  const record: {
    id: string;
    severity: "error" | "warning";
    message: string;
    file?: string;
    line?: number;
    column?: number;
  } = { id: finding.id, severity: finding.severity, message: finding.message };
  if (finding.file !== undefined) {
    if (typeof finding.file !== "string" || finding.file === "") {
      throw new ProofError("invalid-doctor", `proof: finding "${finding.id}" has an empty file.`);
    }
    record.file = recordPath(siteRoot, finding.file);
  }
  for (const key of ["line", "column"] as const) {
    const value = finding[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new ProofError("invalid-doctor", `proof: finding "${finding.id}" has an invalid ${key}.`);
    }
    record[key] = value;
  }
  return record;
}

/** The doctor result with findings in a fixed key order, or refused when it does not name a level. */
function doctorRecord(doctor: ProofDoctor, siteRoot: string): ProofDoctor {
  if (doctor.level !== null && !(PROOF_LEVELS as readonly string[]).includes(doctor.level)) {
    throw new ProofError("invalid-doctor", `proof: "${String(doctor.level)}" is not a doctor level.`);
  }
  if (doctor.findings === undefined) return { level: doctor.level };
  return { level: doctor.level, findings: doctor.findings.map((finding) => findingRecord(finding, siteRoot)) };
}

/** The examples summary with sorted, unique ids and whole, non-negative counts. */
function examplesRecord(examples: ProofExamples): ProofExamples {
  for (const id of examples.rerun) {
    if (typeof id !== "string" || id === "") {
      throw new ProofError("invalid-examples", "proof: an examples.rerun entry is not a non-empty string.");
    }
  }
  for (const key of ["passed", "failed", "skipped"] as const) {
    const value = examples[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new ProofError("invalid-examples", `proof: examples.${key} is not a whole number of examples.`);
    }
  }

  const rerun = [...new Set(examples.rerun)].sort(byCodePoint);
  return examples.skipped === undefined
    ? { rerun, passed: examples.passed, failed: examples.failed }
    : { rerun, passed: examples.passed, failed: examples.failed, skipped: examples.skipped };
}

/**
 * Builds the record without touching the filesystem. Every check runs here, so a caller that gets
 * a record back knows the record is complete; {@link writeProof} writes only what this returns.
 */
export function createProof(input: ProofInput): ProofRecord {
  const seen = new Set<string>();
  const files: ProofFile[] = [];

  for (const file of input.files) {
    const path = recordPath(input.siteRoot, file);
    if (seen.has(path)) {
      throw new ProofError("duplicate-path", `proof: "${path}" is listed more than once.`);
    }
    seen.add(path);

    const before = contentOf(input.before, file, "before");
    const after = contentOf(input.after, file, "after");
    files.push({
      path,
      before: before === null ? null : hashOf(before),
      after: after === null ? null : hashOf(after),
    });
  }
  files.sort((a, b) => byCodePoint(a.path, b.path));

  const date = recordDate(input);
  return {
    version: PROOF_VERSION,
    ...(date === undefined ? {} : { date }),
    files,
    ...(input.doctor === undefined ? {} : { doctor: doctorRecord(input.doctor, input.siteRoot) }),
    ...(input.examples === undefined ? {} : { examples: examplesRecord(input.examples) }),
  };
}

/** The record's bytes: two-space indentation, a line feed at the end, and keys in record order. */
export function formatProof(record: ProofRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Writes `text` whole: a fresh folder beside the target, one file, then one rename into place. */
async function writeAtomic(out: string, text: string): Promise<void> {
  const folder = dirname(out);
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(`${folder}${sep}.proof-`);
  try {
    const temp = `${staging}${sep}proof.json`;
    await writeFile(temp, text, "utf8");
    await rename(temp, out);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Writes the proof record at `out` and returns it. The record is built and checked first, so a
 * refusal leaves no file behind; a successful write replaces an old record with one rename.
 */
export async function writeProof(options: WriteProofOptions): Promise<ProofRecord> {
  const record = createProof(options);
  const out = isAbsolute(options.out) ? options.out : resolve(options.siteRoot, options.out);
  await writeAtomic(out, formatProof(record));
  return record;
}
