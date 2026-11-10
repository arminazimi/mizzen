import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";

/**
 * Page age against code (N10): how long a page has been older than the newest file it references.
 *
 * Git history is an input, not something this module observes on its own. For a fixed repository, the
 * same `root`, page, and references give the same result, because every date comes from a commit and
 * nothing reads the clock. The answer is `"unknown"` rather than an error when git,
 * a work tree, or a commit for the page is missing, which is what a shallow clone or an unpacked
 * tarball looks like.
 *
 * One `git rev-parse` per root and one `git log` per path are kept in a process-wide cache, so a check
 * that asks about the same page and references again pays for neither. The cache is keyed by the
 * resolved root; a caller that changes the repository at that root after a call still sees the dates
 * from before, so pass a fresh root for a fresh history. `outputs/feed.ts` has the same repository check
 * and date lookup for its feed; the two are kept apart until a shared refactor can move both.
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

/** One root's git state: whether it is a work tree, and the dates already asked about. */
interface History {
  /** True when `root` is inside a git work tree; the dates are trusted only then. */
  readonly available: boolean;
  /** The resolved root git runs in. */
  readonly root: string;
  /** `%cI` dates by repository-relative path, so each path is asked about once. */
  readonly dates: Map<string, Date | undefined>;
}

/** Every root already checked in this process. */
const histories = new Map<string, History>();

/** Checks once whether `root` is inside a work tree, then remembers the answer for later calls. */
function historyAt(root: string): History {
  const key = resolve(root);
  const cached = histories.get(key);
  if (cached !== undefined) return cached;

  let available = false;
  try {
    available =
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: key,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
  } catch {
    available = false;
  }
  const history: History = { available, root: key, dates: new Map() };
  histories.set(key, history);
  return history;
}

/** The committer date of the last commit that touched `path`; `undefined` when git has no answer. */
function dateOf(history: History, path: string): Date | undefined {
  if (history.dates.has(path)) return history.dates.get(path);
  let date: Date | undefined;
  try {
    const text = execFileSync("git", ["log", "-1", "--format=%cI", "--", path], {
      cwd: history.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (text !== "") {
      const parsed = new Date(text);
      if (!Number.isNaN(parsed.getTime())) date = parsed;
    }
  } catch {
    date = undefined;
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
 * has no commit, or none of the references has one. The call shell outs to git at most once per root
 * and once per path across calls with the same root.
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
