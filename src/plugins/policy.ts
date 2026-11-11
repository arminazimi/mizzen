/**
 * The limits one hook stage applies to each plugin's hook.
 *
 * The deadline is asynchronous: it stops the runner from waiting, not the hook itself. A CPU-bound synchronous hook
 * cannot be preempted and a timed-out asynchronous hook keeps running in this process until it settles, so this is a
 * predictability boundary and not a sandbox or process isolation.
 */
export interface HookPolicy {
  /**
   * Milliseconds one hook call may run before the stage stops waiting for it. `0` disables the deadline.
   * Default: {@link DEFAULT_HOOK_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
}

/** The default deadline of one hook call: ten seconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** The policy a runner uses when its caller names none. */
export const DEFAULT_HOOK_POLICY: HookPolicy = Object.freeze({ timeoutMs: DEFAULT_HOOK_TIMEOUT_MS });

/** Node's timers fire after 1 ms when asked for more than this, so a larger deadline is capped. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Validates `policy` and returns the deadline of one hook call.
 * A caller's mistake, such as a negative or non-finite limit, is a throw and never a diagnostic about a plugin.
 */
export function resolveHookTimeout(policy: HookPolicy = DEFAULT_HOOK_POLICY): number {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      `HookPolicy.timeoutMs must be a finite number of milliseconds, zero or more, not ${String(timeoutMs)}.`,
    );
  }
  return timeoutMs;
}

/** The deadline of one hook call; `timeoutMs` is never reused for another call. */
class HookDeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The hook did not finish within ${timeoutMs} ms.`);
    this.timeoutMs = timeoutMs;
  }
}

/** True for the error {@link runWithinDeadline} makes when a hook misses its deadline. */
export function isHookDeadline(err: unknown): err is HookDeadlineError {
  return err instanceof HookDeadlineError;
}

/**
 * Waits for `work` until `timeoutMs` passes. A result after the deadline is ignored, and its rejection is handled here
 * so it never surfaces as an unhandled rejection. The timer is cleared on every path, so it does not survive the stage.
 */
export async function runWithinDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs === 0) return work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // shortcut: a deadline above Node's timer maximum waits that maximum (about 24.8 days); re-arm it if longer
    // deadlines ever matter.
    timer = setTimeout(() => reject(new HookDeadlineError(timeoutMs)), Math.min(timeoutMs, MAX_TIMER_MS));
  });
  // The race below handles both outcomes too, but this branch makes the guarantee explicit for a promise that settles
  // after the deadline.
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isSourcePos(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.file === "string" &&
    isCount(value.line) &&
    isCount(value.column) &&
    isCount(value.endLine) &&
    isCount(value.endColumn)
  );
}

/** The path of a field under `at`, for messages such as `` `pages[0].url` ``. */
function field(at: string, name: string): string {
  return at === "" ? name : `${at}.${name}`;
}

const DIRECTIONS = new Set(["ltr", "rtl"]);
const KINDS = new Set(["doc", "app", "asset"]);

/** What is wrong with the page at `at`, or `undefined` when it is usable. */
function pageDefect(value: unknown, at: string): string | undefined {
  if (!isPlainObject(value)) return at === "" ? "is not an object" : `\`${at}\` is not a page`;

  const url = field(at, "url");
  if (typeof value.url !== "string" || !value.url.startsWith("/")) {
    return `\`${url}\` is not a string starting with \`/\``;
  }
  const source = field(at, "source");
  if (!isSourcePos(value.source)) return `\`${source}\` is not a source position`;
  const frontMatter = field(at, "frontMatter");
  if (!isPlainObject(value.frontMatter)) return `\`${frontMatter}\` is not an object`;
  const title = field(at, "title");
  if (typeof value.title !== "string") return `\`${title}\` is not a string`;
  const lang = field(at, "lang");
  if (typeof value.lang !== "string") return `\`${lang}\` is not a string`;
  const dir = field(at, "dir");
  if (typeof value.dir !== "string" || !DIRECTIONS.has(value.dir)) return `\`${dir}\` is not "ltr" or "rtl"`;
  const html = field(at, "html");
  if (typeof value.html !== "string") return `\`${html}\` is not a string`;
  const markdown = field(at, "markdown");
  if (typeof value.markdown !== "string") return `\`${markdown}\` is not a string`;
  const kind = field(at, "kind");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) {
    return `\`${kind}\` is not "doc", "app", or "asset"`;
  }

  const headings = field(at, "headings");
  if (!Array.isArray(value.headings)) return `\`${headings}\` is not a list`;
  for (let index = 0; index < value.headings.length; index += 1) {
    const problem = headingDefect(value.headings[index], `${headings}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** What is wrong with the heading at `at`, or `undefined` when it is usable. */
function headingDefect(value: unknown, at: string): string | undefined {
  if (!isPlainObject(value)) return `\`${at}\` is not a heading`;
  if (typeof value.depth !== "number" || !Number.isInteger(value.depth) || value.depth < 1 || value.depth > 6) {
    return `\`${at}.depth\` is not 1 to 6`;
  }
  if (typeof value.id !== "string") return `\`${at}.id\` is not a string`;
  if (typeof value.text !== "string") return `\`${at}.text\` is not a string`;
  if (!isSourcePos(value.pos)) return `\`${at}.pos\` is not a source position`;
  return undefined;
}

/** What is wrong with the navigation item at `at`, or `undefined` when it is usable. */
function navItemDefect(value: unknown, at: string): string | undefined {
  if (!isPlainObject(value)) return `\`${at}\` is not a navigation item`;
  if (typeof value.title !== "string") return `\`${at}.title\` is not a string`;
  const hasChildren = value.children !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasChildren === hasUrl) return `\`${at}\` is neither a link nor a group`;
  if (hasUrl) {
    if (typeof value.url !== "string") return `\`${at}.url\` is not a string`;
    if (value.match !== undefined && typeof value.match !== "string") {
      return `\`${at}.match\` is not a string`;
    }
    return undefined;
  }
  if (!Array.isArray(value.children)) return `\`${at}.children\` is not a list`;
  for (let index = 0; index < value.children.length; index += 1) {
    const problem = navItemDefect(value.children[index], `${at}.children[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** What is wrong with the navigation tree, or `undefined` when it is usable. */
function navDefect(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "`nav` is not an object";
  for (const [name, list] of Object.entries(value)) {
    if (!Array.isArray(list)) return `\`nav.${name}\` is not a list`;
    for (let index = 0; index < list.length; index += 1) {
      const problem = navItemDefect(list[index], `nav.${name}[${index}]`);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/** Names the malformed part of a page a plugin returned, or `undefined` when the page is usable. */
export function pageProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "something that is not a page";
  const defect = pageDefect(value, "");
  return defect === undefined ? undefined : `a page whose ${defect}`;
}

/** Names the malformed part of a site model a plugin returned, or `undefined` when the model is usable. */
export function siteProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "something that is not a site model";
  if (!isPlainObject(value.config)) return "a site model whose `config` is not an object";
  if (!Array.isArray(value.pages)) return "a site model whose `pages` is not a list";
  for (let index = 0; index < value.pages.length; index += 1) {
    const defect = pageDefect(value.pages[index], `pages[${index}]`);
    if (defect !== undefined) return `a site model whose ${defect}`;
  }
  const nav = navDefect(value.nav);
  if (nav !== undefined) return `a site model whose ${nav}`;
  if (!isPlainObject(value.data)) return "a site model whose `data` is not an object";
  return undefined;
}

/** True for a path an output may write: relative, `/`-separated, and with no empty, `.`, or `..` segment. */
function isInsideOutput(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Names what is wrong with the output files a plugin returned, or `undefined` when they are usable: every path is
 * inside the output folder, no two files write one path, and every content is text or bytes.
 */
export function outputFilesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "something that is not a list of output files";

  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const file: unknown = value[index];
    const at = `file ${index + 1}`;
    if (!isPlainObject(file)) return `a list of output files whose ${at} is not an output file`;
    if (typeof file.path !== "string") return `a list of output files whose ${at} has no string \`path\``;
    if (!isInsideOutput(file.path)) {
      return `a list of output files whose ${at} writes ${JSON.stringify(file.path)}, which is not inside the output folder`;
    }
    if (seen.has(file.path)) {
      return `a list of output files that writes ${JSON.stringify(file.path)} twice`;
    }
    seen.add(file.path);
    const contents: unknown = file.contents;
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      return `a list of output files whose ${at} (${JSON.stringify(file.path)}) has contents that are neither text nor bytes`;
    }
  }
  return undefined;
}
