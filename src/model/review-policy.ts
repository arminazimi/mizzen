/**
 * Review policy (N65): which review window and how many distinct reviewers a page needs, chosen by its
 * source path.
 *
 * The policy is read from `_data/review-policy.yml` (`site.data["review-policy"]`, also readable as
 * `site.data.reviewPolicy`). The shape is one default policy plus an ordered list of path rules:
 *
 * ```yaml
 * windowDays: 180
 * minReviewers: 1
 * rules:
 *   - path: guide/security
 *     windowDays: 30
 *     minReviewers: 2
 * ```
 *
 * `windowDays` is how many whole days a review stays fresh; a review older than that is `overdue`.
 * `minReviewers` is how many distinct mailmap author names must have touched the page inside that window.
 * A rule may set only one field and inherits the other from the default. A rule's `path` is a source path
 * relative to the site root, using `/`; it matches the exact file and every file below it, at a segment
 * boundary, so `guide/security` matches `guide/security/keys.md` but not `guide/security-notes.md`. A
 * trailing `/**` is accepted as the same folder prefix.
 *
 * **Most specific wins.** A page uses the rule with the longest matching path. When two rules have the same
 * path, the later rule in the list wins, so a site can append an override without rewriting the list. A
 * page no rule matches uses the default policy. The default is 180 days and one reviewer, the same 180-day
 * freshness the trust model uses; no config or clock is read here.
 *
 * **Invalid input never silently becomes a policy.** A policy that is not a mapping, a `rules` value that
 * is not a list, and a rule with a missing or invalid path, window, or reviewer count are reported as
 * diagnostics. An invalid default field falls back to the built-in default for that field only. An invalid
 * rule is ignored as a whole, so it cannot accidentally make a sensitive page easier to satisfy. Numeric
 * strings are accepted as whole numbers, as they are elsewhere in the data channel.
 *
 * The resolver is pure: it reads no environment, clock, or filesystem. The same input always yields the
 * same rules, in the same order, and the same diagnostics.
 */

/** How long a review stays fresh and how many distinct reviewers it needs. */
export interface ReviewPolicy {
  /** Whole days a review stays fresh. At least 1. */
  readonly windowDays: number;
  /** Distinct mailmap author names required inside the window. At least 1. */
  readonly minReviewers: number;
}

/** One path rule: a policy for one source path and everything below it. */
export interface ReviewPolicyRule extends ReviewPolicy {
  /** Root-relative source path, using `/`, with no leading or trailing slash. */
  readonly path: string;
}

/** The policy that applies to one page, and the rule path that selected it (`null` for the default). */
export interface MatchedReviewPolicy extends ReviewPolicy {
  /** The matched rule path, or `null` when the default policy applies. */
  readonly path: string | null;
}

/** A stable code for one policy problem. */
export type ReviewPolicyDiagnosticCode =
  | "review-policy.invalid"
  | "review-policy.invalid-default"
  | "review-policy.invalid-rules"
  | "review-policy.invalid-rule";

/** One reason a policy value could not be used as written. */
export interface ReviewPolicyDiagnostic {
  /** A stable identifier; the same problem always gets the same code. */
  readonly code: ReviewPolicyDiagnosticCode;
  /** The sentence a maintainer reads. */
  readonly message: string;
  /** The 1-based position of the rule in `rules`, when the finding is about one rule. */
  readonly rule?: number;
}

/** The usable policy: a default plus the valid rules in their declared order. */
export interface ReviewPolicyResolution {
  /** The policy for a page no rule matches. */
  readonly default: ReviewPolicy;
  /** The valid rules, in declaration order. Invalid rules are left out. */
  readonly rules: readonly ReviewPolicyRule[];
  /** Every problem found while resolving the value, in discovery order. */
  readonly diagnostics: readonly ReviewPolicyDiagnostic[];
}

/** The policy used when the site declares none. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = { windowDays: 180, minReviewers: 1 };

/** The `_data` key `_data/review-policy.yml` loads under. */
export const REVIEW_POLICY_KEY = "review-policy";

/** The `_data` key `_data/reviewPolicy.yml` loads under. */
export const REVIEW_POLICY_ALIAS_KEY = "reviewPolicy";

/** True for a plain object, which is what a YAML mapping or a JSON object becomes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole number of at least one, from a YAML or JSON value; strings are read as numbers, as elsewhere. */
function positiveIntegerOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}

/**
 * A rule path normalized for matching, or `undefined` when it is not a confined relative path. Backslashes
 * are read as `/`, `./` and trailing slashes are ignored, and one trailing `/**` or `/*` is accepted as the
 * folder prefix. Empty segments, `.`, `..`, an absolute path, a drive letter, and any other glob character
 * are rejected rather than matched as literals, so a typo cannot silently apply to the wrong files.
 */
function normalizeRulePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let path = value.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path.endsWith("/**")) path = path.slice(0, -3).replace(/\/+$/, "");
  else if (path.endsWith("/*")) path = path.slice(0, -2).replace(/\/+$/, "");
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) return undefined;
  if (/[*?[\]{}]/.test(path)) return undefined;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") ? path : undefined;
}

/**
 * A page's source file normalized for matching, or `undefined` when it is not a confined relative path.
 * A source path the engine cannot confine matches no rule, so the page keeps the default policy.
 */
function normalizeSourcePath(value: string): string | undefined {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path === "" || path.startsWith("/") || path.includes("\0")) return undefined;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") ? path : undefined;
}

/** True when `rulePath` names `source` itself or a folder containing it, at a path-segment boundary. */
function matchesPath(rulePath: string, source: string): boolean {
  return source === rulePath || source.startsWith(`${rulePath}/`);
}

/** The policy for a page: the longest matching rule, later rule first when paths tie, or the default. */
export function policyFor(resolution: ReviewPolicyResolution, sourceFile: string): MatchedReviewPolicy {
  const source = normalizeSourcePath(sourceFile);
  if (source === undefined) {
    return { ...resolution.default, path: null };
  }

  let matched: ReviewPolicyRule | undefined;
  for (const rule of resolution.rules) {
    if (!matchesPath(rule.path, source)) continue;
    // `>=` lets a later rule at the same path override an earlier one; a longer path is always more specific.
    if (matched === undefined || rule.path.length >= matched.path.length) matched = rule;
  }

  return matched === undefined
    ? { ...resolution.default, path: null }
    : { windowDays: matched.windowDays, minReviewers: matched.minReviewers, path: matched.path };
}

/** One field of the default policy: a valid value, or the built-in and one diagnostic. */
function defaultFieldOf(
  value: unknown,
  field: "windowDays" | "minReviewers",
  fallback: number,
  diagnostics: ReviewPolicyDiagnostic[],
): number {
  if (value === undefined) return fallback;
  const number = positiveIntegerOf(value);
  if (number !== undefined) return number;
  diagnostics.push({
    code: "review-policy.invalid-default",
    message: `The review policy default has an invalid "${field}"; ${fallback} is used.`,
  });
  return fallback;
}

/** The default policy from the mapping, falling back field by field and reporting what it could not read. */
function defaultPolicyOf(value: Record<string, unknown>, diagnostics: ReviewPolicyDiagnostic[]): ReviewPolicy {
  let source: unknown = value;
  if (value.default !== undefined) {
    source = value.default;
    if (!isRecord(source)) {
      diagnostics.push({
        code: "review-policy.invalid-default",
        message: "The review policy default is not a mapping; the built-in default is used.",
      });
      source = {};
    }
  }
  const record = isRecord(source) ? source : {};
  return {
    windowDays: defaultFieldOf(record.windowDays, "windowDays", DEFAULT_REVIEW_POLICY.windowDays, diagnostics),
    minReviewers: defaultFieldOf(
      record.minReviewers,
      "minReviewers",
      DEFAULT_REVIEW_POLICY.minReviewers,
      diagnostics,
    ),
  };
}

/** The rule at one position, or `undefined` with a diagnostic when any of its fields cannot be used. */
function ruleOf(
  value: unknown,
  index: number,
  defaultPolicy: ReviewPolicy,
  diagnostics: ReviewPolicyDiagnostic[],
): ReviewPolicyRule | undefined {
  const rule = index + 1;
  if (!isRecord(value)) {
    diagnostics.push({ code: "review-policy.invalid-rule", message: `Review rule ${rule} is not a mapping; it is ignored.`, rule });
    return undefined;
  }

  const path = normalizeRulePath(value.path);
  if (path === undefined) {
    diagnostics.push({
      code: "review-policy.invalid-rule",
      message: `Review rule ${rule} has no confined relative "path"; it is ignored.`,
      rule,
    });
    return undefined;
  }

  const windowDays =
    value.windowDays === undefined
      ? defaultPolicy.windowDays
      : positiveIntegerOf(value.windowDays);
  if (windowDays === undefined) {
    diagnostics.push({
      code: "review-policy.invalid-rule",
      message: `Review rule ${rule} ("${path}") has an invalid "windowDays"; it is ignored.`,
      rule,
    });
    return undefined;
  }

  const minReviewers =
    value.minReviewers === undefined
      ? defaultPolicy.minReviewers
      : positiveIntegerOf(value.minReviewers);
  if (minReviewers === undefined) {
    diagnostics.push({
      code: "review-policy.invalid-rule",
      message: `Review rule ${rule} ("${path}") has an invalid "minReviewers"; it is ignored.`,
      rule,
    });
    return undefined;
  }

  return { path, windowDays, minReviewers };
}

/**
 * Reads a policy value into the usable default and rules, and the diagnostics that explain what was left
 * out. `undefined` and `null` mean the built-in default with no rules; anything else that is not a mapping
 * is one diagnostic and the built-in default. The returned rules keep their declared order, which is what
 * breaks a tie between two rules with the same path.
 */
export function resolveReviewPolicy(value: unknown): ReviewPolicyResolution {
  const diagnostics: ReviewPolicyDiagnostic[] = [];
  if (value === undefined || value === null) {
    return { default: { ...DEFAULT_REVIEW_POLICY }, rules: [], diagnostics };
  }
  if (!isRecord(value)) {
    return {
      default: { ...DEFAULT_REVIEW_POLICY },
      rules: [],
      diagnostics: [
        {
          code: "review-policy.invalid",
          message: "The review policy is not a mapping; the built-in default is used.",
        },
      ],
    };
  }

  const defaultPolicy = defaultPolicyOf(value, diagnostics);
  const rulesValue = value.rules;
  if (rulesValue !== undefined && !Array.isArray(rulesValue)) {
    diagnostics.push({
      code: "review-policy.invalid-rules",
      message: 'The review policy "rules" is not a list; no path rules are used.',
    });
    return { default: defaultPolicy, rules: [], diagnostics };
  }

  const rules: ReviewPolicyRule[] = [];
  for (const [index, entry] of (rulesValue ?? []).entries()) {
    const rule = ruleOf(entry, index, defaultPolicy, diagnostics);
    if (rule !== undefined) rules.push(rule);
  }
  return { default: defaultPolicy, rules, diagnostics };
}

/**
 * The raw policy value in the site data: `_data/review-policy.yml` when present, otherwise the camelCase
 * `_data/reviewPolicy.yml`. The hyphenated key wins when both files exist, so the documented name is the
 * one that decides.
 */
export function reviewPolicyValue(data: Readonly<Record<string, unknown>>): unknown {
  return data[REVIEW_POLICY_KEY] ?? data[REVIEW_POLICY_ALIAS_KEY];
}
