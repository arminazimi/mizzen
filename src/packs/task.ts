/**
 * The deterministic half of the context-request contract: parse untrusted input into
 * {@link ContextRequest}, or explain every way it is malformed.
 *
 * The shape is checked against `../../schema/context-request.schema.json` with ajv; ajv's findings
 * are translated into a JSON Pointer and a sentence that says what to write instead. Once the shape
 * is valid, the cross-field rules run: an include hint cannot also be excluded, required evidence
 * cannot be excluded, `reservedTokens` must leave room under `maxTokens`, and a version range cannot
 * be empty or mix `exact` with bounds. The parser fills defaults and trims hints, so a valid request
 * has one stable form: two runs on the same input give the same bytes.
 *
 * Parsing is local and synchronous: no network, no model, no clock, no site read. It also never
 * infers a task. `task.kind` stays absent when the caller omits it; inferring it from `goal` would be
 * a separate, optional transform over a parsed request.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  ContextRequest,
  ContextRequestProblem,
  ContextRequestResult,
  EvidenceRequirement,
  TaskKind,
  VersionRange,
} from "../contracts/context-request.ts";

/** The only context-request version this parser accepts. */
export const CONTEXT_REQUEST_VERSION = 1;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/context-request.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

/** A version range as validation leaves it, before the cross-field checks. */
interface RawVersionRange {
  readonly exact?: string;
  readonly min?: string;
  readonly max?: string;
}

/** A request as validation leaves it: the schema's optional fields are still optional. */
interface RawContextRequest {
  readonly version: 1;
  readonly task: { readonly goal: string; readonly kind?: TaskKind };
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly constraints?: { readonly locale?: string; readonly version?: RawVersionRange };
  readonly budget: { readonly maxTokens: number; readonly reservedTokens?: number };
  readonly requiredEvidence?: {
    readonly refs?: readonly string[];
    readonly source?: boolean;
    readonly versions?: boolean;
    readonly warnings?: boolean;
    readonly dependencies?: boolean;
  };
}

/** What a missing field should have held, by field name. */
const MISSING_FIELD_HELP: Readonly<Record<string, string>> = {
  version: "Set `version` to 1, the only context-request version.",
  task: "Give the request a `task` object with a `goal`.",
  goal: "Describe the task in `task.goal` as one sentence.",
  budget: "Give the request a `budget` object with `maxTokens`.",
  maxTokens: "Set it to a positive whole number of estimated tokens.",
};

/**
 * Parses a context request from an already-decoded JSON value such as `JSON.parse(text)`.
 *
 * Shape problems and cross-field contradictions are reported together only when the shape is
 * valid; a request whose shape is broken reports every shape problem first, because reading the
 * contradictions would need values the schema has not accepted yet.
 */
export function parseContextRequest(value: unknown): ContextRequestResult {
  if (!validateShape(value)) {
    return { problems: (validateShape.errors ?? []).map((error) => problemFromAjv(error, value)) };
  }
  return normalize(value as RawContextRequest);
}

/** Trims every hint and keeps the caller's order. */
function hintsOf(values: readonly string[] | undefined): readonly string[] {
  return values === undefined ? [] : values.map((value) => value.trim());
}

/** Reports a hint that repeats an earlier one once whitespace is trimmed. */
function reportDuplicates(
  values: readonly string[],
  prefix: string,
  problems: ContextRequestProblem[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      problems.push({
        path: `${prefix}/${index}`,
        code: "context-request.duplicate",
        message: `${whereOf(`${prefix}/${index}`)} repeats \`${value}\`; remove the duplicate.`,
      });
    }
    seen.add(value);
  }
}

/** Fills defaults and checks the rules a single field cannot express. */
function normalize(raw: RawContextRequest): ContextRequestResult {
  const problems: ContextRequestProblem[] = [];
  const include = hintsOf(raw.include);
  const exclude = hintsOf(raw.exclude);

  reportDuplicates(include, "/include", problems);
  reportDuplicates(exclude, "/exclude", problems);

  for (const [index, hint] of exclude.entries()) {
    if (include.includes(hint)) {
      problems.push({
        path: `/exclude/${index}`,
        code: "context-request.include-excluded",
        message: `\`${hint}\` is both included and excluded; remove it from one of the two lists.`,
      });
    }
  }

  const version = versionOf(raw.constraints?.version, problems);
  const { maxTokens, reservedTokens } = raw.budget;
  if (reservedTokens !== undefined && reservedTokens >= maxTokens) {
    problems.push({
      path: "/budget/reservedTokens",
      code: "context-request.reserved-over-budget",
      message: `\`reservedTokens\` is ${reservedTokens}, which leaves nothing to spend of \`maxTokens\` (${maxTokens}); make it smaller than \`maxTokens\`.`,
    });
  }

  const refs = hintsOf(raw.requiredEvidence?.refs);
  reportDuplicates(refs, "/requiredEvidence/refs", problems);
  for (const [index, ref] of refs.entries()) {
    if (exclude.includes(ref)) {
      problems.push({
        path: `/requiredEvidence/refs/${index}`,
        code: "context-request.evidence-excluded",
        message: `Required evidence \`${ref}\` is also excluded; remove it from \`exclude\` or from \`requiredEvidence.refs\`.`,
      });
    }
  }

  const request: ContextRequest = {
    version: CONTEXT_REQUEST_VERSION,
    task: {
      goal: raw.task.goal.trim(),
      ...(raw.task.kind === undefined ? {} : { kind: raw.task.kind }),
    },
    include,
    exclude,
    constraints: {
      ...(raw.constraints?.locale === undefined ? {} : { locale: raw.constraints.locale.toLowerCase() }),
      ...(version === undefined ? {} : { version }),
    },
    budget: {
      maxTokens,
      ...(reservedTokens === undefined ? {} : { reservedTokens }),
    },
    requiredEvidence: evidenceOf(raw.requiredEvidence, refs),
  };

  return problems.length === 0 ? { request, problems } : { problems };
}

/** A version range, refused when it mixes `exact` with bounds or runs backwards. */
function versionOf(
  range: RawVersionRange | undefined,
  problems: ContextRequestProblem[],
): VersionRange | undefined {
  if (range === undefined) return undefined;
  const { exact, min, max } = range;

  if (exact === undefined && min === undefined && max === undefined) {
    problems.push({
      path: "/constraints/version",
      code: "context-request.version-empty",
      message: "A version range needs `exact`, `min`, or `max`; an empty one constrains nothing.",
    });
  }
  if (exact !== undefined && (min !== undefined || max !== undefined)) {
    problems.push({
      path: "/constraints/version/exact",
      code: "context-request.version-conflict",
      message: `\`exact\` (${exact}) cannot be combined with \`min\` or \`max\`; use \`exact\` for one version, or \`min\` and \`max\` for a range.`,
    });
  }
  if (min !== undefined && max !== undefined && compareVersions(min, max) > 0) {
    problems.push({
      path: "/constraints/version/min",
      code: "context-request.version-order",
      message: `\`min\` (${min}) is newer than \`max\` (${max}); swap them or widen the range.`,
    });
  }

  return {
    ...(exact === undefined ? {} : { exact }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

/** The evidence requirement with the defaults filled. */
function evidenceOf(
  raw: RawContextRequest["requiredEvidence"],
  refs: readonly string[],
): EvidenceRequirement {
  return {
    refs,
    source: raw?.source ?? false,
    versions: raw?.versions ?? false,
    warnings: raw?.warnings ?? false,
    dependencies: raw?.dependencies ?? false,
  };
}

/** A digit string without leading zeros, so equal values have equal digits; absent and zero both become "". */
function digitsOf(part: string | undefined): string {
  return (part ?? "0").replace(/^0+/, "");
}

/** The `vN`, `vN.M`, or `vN.M.P` parts as normalized digits; the schema has already checked the shape. */
function versionParts(name: string): readonly [string, string, string] {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(name);
  return [digitsOf(match?.[1]), digitsOf(match?.[2]), digitsOf(match?.[3])];
}

/** Compares two non-negative decimal digit strings exactly: no leading zeros, then shorter is smaller. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Compares two version folders by their numeric parts: a missing or zero part counts as zero, so
 * `v2`, `v2.0`, and `v2.0.0` are equal, and the comparison never converts a part to a Number.
 */
function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < left.length; index += 1) {
    const difference = compareDigits(left[index] ?? "", right[index] ?? "");
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The JSON Pointer of an ajv finding, with a missing key or duplicate index appended. */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") return joinPointer(error.instancePath, String(error.params.missingProperty ?? ""));
  if (error.keyword === "uniqueItems" && typeof error.params.i === "number") {
    return joinPointer(error.instancePath, String(error.params.i));
  }
  return error.instancePath;
}

/** JSON Pointer escaping for `~` and `/`. */
function joinPointer(base: string, segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return base === "" ? `/${escaped}` : `${base}/${escaped}`;
}

/** The value at a pointer in the request, for naming its type or a duplicate entry. */
function valueAt(root: unknown, pointer: string): unknown {
  let value: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      value = value[Number(segment)];
    } else if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

/** A value's type as a sentence fragment, such as `a string` or `an array`. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return Number.isInteger(value) ? "an integer" : "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

/** The expected JSON type as a sentence fragment. */
function expectedType(type: unknown): string {
  switch (type) {
    case "integer":
      return "an integer";
    case "number":
      return "a number";
    case "string":
      return "a string";
    case "boolean":
      return "a boolean";
    case "array":
      return "an array";
    case "object":
      return "an object";
    case "null":
      return "null";
    default:
      return String(type);
  }
}

/** The request or value a message is about. */
function whereOf(pointer: string): string {
  return pointer === "" ? "The request" : `\`${pointer}\``;
}

/** What a pattern-constrained field should look like, so the message says what to write. */
function formatHint(pointer: string): string {
  if (pointer.endsWith("/constraints/locale")) return "a BCP 47 language tag such as `en`, `fa`, or `en-US`";
  if (pointer.includes("/constraints/version/")) return "a version folder such as `v2`, `v2.1`, or `v2.1.3`";
  if (pointer.endsWith("/task/goal")) return "a non-empty sentence";
  return "a non-empty string";
}

/** Translates one ajv finding into a stable code, a pointer, and a sentence to act on. */
function problemFromAjv(error: ErrorObject, root: unknown): ContextRequestProblem {
  const path = pointerOf(error);

  switch (error.keyword) {
    case "required": {
      const key = String(error.params.missingProperty ?? "");
      const help = MISSING_FIELD_HELP[key];
      return {
        path,
        code: "context-request.missing",
        message: `Missing required field \`${key}\`.${help === undefined ? "" : ` ${help}`}`,
      };
    }
    case "additionalProperties": {
      const key = String(error.params.additionalProperty ?? "");
      const allowed = Object.keys(
        (error.parentSchema?.properties ?? {}) as Record<string, unknown>,
      ).sort();
      return {
        path: joinPointer(error.instancePath, key),
        code: "context-request.unknown-key",
        message: `Unknown field \`${key}\`. Use one of: ${allowed.map((name) => `\`${name}\``).join(", ")}.`,
      };
    }
    case "type":
      return {
        path,
        code: "context-request.type",
        message: `${whereOf(path)} must be ${expectedType(error.params.type)}; found ${typeOf(valueAt(root, path))}.`,
      };
    case "const":
      return {
        path,
        code: "context-request.version",
        message:
          path === "/version"
            ? "Only context-request version 1 is supported."
            : `${whereOf(path)} must be ${JSON.stringify(error.params.allowedValue)}.`,
      };
    case "enum": {
      const allowed = (error.params.allowedValues as readonly unknown[] | undefined) ?? [];
      return {
        path,
        code: "context-request.enum",
        message: `${whereOf(path)} must be one of: ${allowed.map((value) => `\`${String(value)}\``).join(", ")}.`,
      };
    }
    case "pattern":
      return {
        path,
        code: "context-request.format",
        message: `${whereOf(path)} must be ${formatHint(path)}.`,
      };
    case "minimum":
      return {
        path,
        code: "context-request.range",
        message: `${whereOf(path)} must be at least ${String(error.params.limit)}.`,
      };
    case "maximum":
      return {
        path,
        code: "context-request.range",
        message: `${whereOf(path)} must be at most ${String(error.params.limit)}.`,
      };
    case "minLength":
      return {
        path,
        code: "context-request.empty",
        message: `${whereOf(path)} must not be empty.`,
      };
    case "minItems":
      return {
        path,
        code: "context-request.empty",
        message: `${whereOf(path)} must not be empty.`,
      };
    case "maxItems":
      return {
        path,
        code: "context-request.range",
        message: `${whereOf(path)} must have at most ${String(error.params.limit)} entries.`,
      };
    case "uniqueItems": {
      const entries = valueAt(root, error.instancePath);
      const index = typeof error.params.i === "number" ? error.params.i : undefined;
      const value = Array.isArray(entries) && index !== undefined ? entries[index] : undefined;
      return {
        path,
        code: "context-request.duplicate",
        message:
          value === undefined
            ? `${whereOf(path)} must not repeat an entry.`
            : `${whereOf(path)} repeats \`${String(value)}\`; remove the duplicate.`,
      };
    }
    default:
      return {
        path,
        code: `context-request.${error.keyword}`,
        message: `${whereOf(path)} ${error.message ?? "is invalid"}.`,
      };
  }
}
