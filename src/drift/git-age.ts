import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";

/**
 * Page age against code (N10): how long a page has been older than the newest file it references.
 *
 * Git history is an input, not something this module observes on its own. For a fixed repository state, the
 * same `root`, page, and references give the same result, because every date comes from a commit and
 * nothing reads the clock. The answer is `"unknown"` rather than an error when git,
 * a work tree, or a commit for the page is missing, which is what a shallow clone or an unpacked
 * tarball looks like.
 *
 * A long-lived build keeps its answers for as long as they describe the repository: the dates of each path
 * are cached per root, and the cache is thrown away when that root's state changes. The state is HEAD's
 * commit together with whether the root is a work tree, so a watcher that commits at the same root sees the
 * new page and code dates on the next call, while an unchanged HEAD costs no `git log` at all. A root that
 * could not be read is probed again for the same reason — an early failure is a snapshot, not a verdict.
 * Nothing here falls back to the clock or to file mtimes: no commit, no date, `"unknown"`.
 *
 * Each call runs at most two `git rev-parse` commands per root to read that state; one `git log` per path is
 * kept until the state moves. Every git call is bounded to {@link GIT_TIMEOUT_MS} and {@link GIT_MAX_OUTPUT_BYTES},
 * and a call that misses either limit answers `"unknown"`, never a partial date. `outputs/feed.ts` has the same
 * repository check and date lookup for its feed; the two are kept apart until a shared refactor can move both.
 */

/** One page's age relative to the code it references. */
export interface GitAge {
  /**
   * Whole 24-hour periods from the page's last commit to the newest referenced commit. Positive when
   * the code is newer than the page, zero within the same day, negative when the page is newer.
   */
  readonly days: number;
  /** Committer date of the last commit that touched the page, from `%cI`. */
  readonly pageDate: Date;
  /** Committer date of the newest commit among the referenced files. */
  readonly codeDate: Date;
}

/** What a comparison can answer: a {@link GitAge}, or `"unknown"` when history cannot support one. */
export type GitAgeResult = GitAge | "unknown";

/** Milliseconds in a whole day. */
const DAY = 86_400_000;

/** The deadline of one git call: a history read that misses it is unknown, not something a build waits on. */
const GIT_TIMEOUT_MS = 10_000;

/** The most stdout one git call may produce; a date needs a line, so a larger answer is discarded unread. */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

/** The part of a root's state the cached dates belong to: whether git can answer at all, and for which commit. */
interface State {
  /** True when `root` is inside a git work tree; the dates are trusted only then. */
  readonly available: boolean;
  /** HEAD's commit, or `undefined` when the repository has none yet, or cannot be read. */
  readonly head: string | undefined;
}

/** One root's git state: the state its dates were read at, and the dates already asked about. */
interface History extends State {
  /** The resolved root git runs in. */
  readonly root: string;
  /** `%cI` dates by repository-relative path, so each path is asked about once per state. */
  readonly dates: Map<string, Date | undefined>;
}

/** Every root already checked in this process. */
const histories = new Map<string, History>();

/** Runs git in `root` and returns trimmed stdout, or `undefined` when git cannot answer or is not installed. */
function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A timeout, an output overflow, a spawn failure, and a non-zero exit all land here: no date beats a partial one.
    return undefined;
  }
}

/** Reads `root`'s state now, so a repository that changed since the last call is not read as unchanged. */
function stateOf(root: string): State {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { available: false, head: undefined };
  const head = git(root, ["rev-parse", "HEAD"]);
  return { available: true, head: head === undefined || head === "" ? undefined : head };
}

/**
 * `root`'s dates, read at `root`'s current state: the cached ones while HEAD and availability are unchanged,
 * and an empty set the moment either moves, which is what makes a new commit visible without losing the
 * caching for the history that did not change.
 */
function historyAt(root: string): History {
  const key = resolve(root);
  const state = stateOf(key);
  const cached = histories.get(key);
  if (cached !== undefined && cached.available === state.available && cached.head === state.head) return cached;

  const history: History = { available: state.available, head: state.head, root: key, dates: new Map() };
  histories.set(key, history);
  return history;
}

/** The committer date of the last commit that touched `path`; `undefined` when git has no answer. */
function dateOf(history: History, path: string): Date | undefined {
  if (history.dates.has(path)) return history.dates.get(path);
  let date: Date | undefined;
  const text = git(history.root, ["log", "-1", "--format=%cI", "--", path]);
  if (text !== undefined && text !== "") {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  history.dates.set(path, date);
  return date;
}

/**
 * `path` as a repository-relative path with `/`, or `undefined` when it is empty or would leave the
 * root. Absolute paths and `..` above the root are refused, so a page cannot ask git about a file
 * outside the repository it names.
 */
function inside(path: string): string | undefined {
  const text = path.replace(/\\/g, "/");
  if (text.trim() === "") return undefined;
  const normalized = posix.normalize(text);
  if (normalized === "." || normalized === ".." || posix.isAbsolute(normalized) || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

/**
 * How old `pageFile` is compared with the files it references: the last commit of the page against the
 * newest commit among `refFiles`, in whole days. Paths are relative to `root` and use `/`; a path that
 * is empty, absolute, or climbs above the root is refused, and a refused page path makes the whole
 * answer `"unknown"` (a refused reference is ignored).
 *
 * Returns `"unknown"`, never an error, when git is not installed, `root` is not a work tree, the page
 * has no commit, or none of the references has one. A git call that misses {@link GIT_TIMEOUT_MS} or
 * {@link GIT_MAX_OUTPUT_BYTES} has no answer either, so a stalled repository cannot hold the caller. The call
 * reads `root`'s state with at most two `git rev-parse` commands and shells out for a date only for a path the
 * current state has not answered yet.
 */
export function gitAge(root: string, pageFile: string, refFiles: readonly string[]): GitAgeResult {
  const pagePath = inside(pageFile);
  if (pagePath === undefined) return "unknown";

  const refs = [...new Set(refFiles.map(inside).filter((path): path is string => path !== undefined))].sort();
  const history = historyAt(root);
  if (!history.available) return "unknown";

  const pageDate = dateOf(history, pagePath);
  if (pageDate === undefined) return "unknown";

  let codeDate: Date | undefined;
  for (const ref of refs) {
    const date = dateOf(history, ref);
    if (date !== undefined && (codeDate === undefined || date.getTime() > codeDate.getTime())) codeDate = date;
  }
  if (codeDate === undefined) return "unknown";

  const days = Math.floor((codeDate.getTime() - pageDate.getTime()) / DAY);
  return { days, pageDate, codeDate };
}
