/**
 * A versioned request for task-specific documentation context.
 *
 * A caller states what an agent is doing, which pages to favour and drop, which language and site
 * version are acceptable, how many tokens it may use, and which evidence must survive trimming.
 * `parseContextRequest` in `../packs/task.ts` turns untrusted input into this shape; nothing here
 * runs, reads a file, or calls a model.
 */

/** The kinds of work a context request can describe. */
export type TaskKind = "explain" | "implement" | "review" | "debug" | "migrate" | "other";

/** What the agent is trying to do. */
export interface TaskIntent {
  /**
   * The task in one sentence, as the caller wrote it. Leading and trailing whitespace is removed
   * when a request is parsed.
   */
  readonly goal: string;
  /**
   * The kind of work, when the caller states it. Parsing never infers a kind from `goal`; an
   * inference step would be a separate, optional transform over this value.
   */
  readonly kind?: TaskKind;
}

/** The site versions acceptable for a request. */
export interface VersionRange {
  /** Only this version folder, such as `v2`. Exclusive with `min` and `max`. */
  readonly exact?: string;
  /** Oldest acceptable version folder, inclusive, such as `v1.2`. */
  readonly min?: string;
  /** Newest acceptable version folder, inclusive, such as `v3`. */
  readonly max?: string;
}

/** Limits on the language and site version of the selected context. */
export interface ContextConstraints {
  /** BCP 47 language tag, such as `fa` or `en-US`; normalised to lower case when parsed. */
  readonly locale?: string;
  /** The site version folders that may supply context. */
  readonly version?: VersionRange;
}

/** The token budget of the whole request. */
export interface TokenBudget {
  /** Upper bound on the estimated tokens of the serialised context; a positive whole number. */
  readonly maxTokens: number;
  /** Tokens held back for required evidence, so trimming cannot spend them; less than `maxTokens`. */
  readonly reservedTokens?: number;
}

/** Evidence that must survive trimming. */
export interface EvidenceRequirement {
  /** Page URLs, source paths, or section ids that must stay in the context. */
  readonly refs: readonly string[];
  /** Keep each selected fragment's source path and span, so a claim can be traced. */
  readonly source: boolean;
  /** Keep the site version and locale each selected fragment came from. */
  readonly versions: boolean;
  /** Keep the warnings attached to selected pages. */
  readonly warnings: boolean;
  /** Keep the pages a selected page depends on. */
  readonly dependencies: boolean;
}

/**
 * A parsed context request: the versioned shape `parseContextRequest` returns when it finds no
 * problem. Keys are always present in this order; the parser fills the defaults.
 */
export interface ContextRequest {
  /** The contract version, always `1`. */
  readonly version: 1;
  /** What the agent is doing; drives ranking and the shape of the pack. */
  readonly task: TaskIntent;
  /** Hints that raise a page's priority, such as a URL, source path, or topic. Default `[]`. */
  readonly include: readonly string[];
  /** Hints that leave a page out, such as a URL, source path, or topic. Default `[]`. */
  readonly exclude: readonly string[];
  /** Language and version limits; empty when the caller sets none. */
  readonly constraints: ContextConstraints;
  /** How many tokens the context may take, and how many are reserved for evidence. */
  readonly budget: TokenBudget;
  /** What trimming may not drop. Default: no named refs, every flag `false`. */
  readonly requiredEvidence: EvidenceRequirement;
}

/** One reason a request was refused. */
export interface ContextRequestProblem {
  /** JSON Pointer to the offending value, such as `/budget/maxTokens`; `""` is the whole request. */
  readonly path: string;
  /** Stable identifier, such as `context-request.reserved-over-budget`; never reused for another meaning. */
  readonly code: string;
  /** What is wrong and what to write instead, in one sentence. */
  readonly message: string;
}

/** The result of {@link parseContextRequest}. */
export interface ContextRequestResult {
  /** The validated request; present exactly when `problems` is empty. */
  readonly request?: ContextRequest;
  /** Every problem found, in request order; empty when the request is valid. */
  readonly problems: readonly ContextRequestProblem[];
}
