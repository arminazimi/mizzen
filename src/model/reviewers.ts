import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

/** What git says about a page's last review: the last commit that touched its source file. */
export interface Review {
  /** The committer instant of that commit, in UTC ISO 8601 (`Date#toISOString`), the same string on every machine. */
  readonly date: string;
  /** The author name of that commit, with `.mailmap` applied (`%aN`). */
  readonly author: string;
}

/** The answer when git has no history for a file: no git, no commit, or a path outside the root. */
export const UNKNOWN = "unknown";

/** A page's last review, or {@link UNKNOWN} when there is no history to read. */
export type ReviewLookup = Review | typeof UNKNOWN;

/** What one repository costs: one work-tree check and one `git log` for the whole root, then lookups from memory. */
interface History {
  /** True when the root is inside a git work tree; the reviews in `reviews` are trusted only then. */
  readonly available: boolean;
  /** Reviews by root-relative path (forward slashes), read by one `git log` on the first lookup; `undefined` until then. */
  reviews: Map<string, Review> | undefined;
}

/** One history per resolved root, so a caller asking about many pages pays for the work-tree check once. */
const HISTORIES = new Map<string, History>();

/** Checks once whether `root` is inside a work tree, so a folder outside git never pays for `git log` per page. */
function historyAt(root: string): History {
  const found = HISTORIES.get(root);
  if (found !== undefined) return found;

  let available = false;
  try {
    available =
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
  } catch {
    available = false;
  }
  const history: History = { available, reviews: undefined };
  HISTORIES.set(root, history);
  return history;
}

/**
 * The path git should be asked about, relative to `root` with forward slashes; `undefined` when the path is empty,
 * the root itself, or resolves outside the root. A path outside the root would let a page borrow another file's
 * history, so it is never asked about.
 */
function gitPathOf(root: string, pageFile: string): string | undefined {
  if (pageFile === "") return undefined;
  const full = resolve(root, pageFile);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (full === root || !full.startsWith(prefix)) return undefined;
  return relative(root, full).split(/[\\/]/).join("/");
}

/** Turns git's committer date into one canonical UTC instant, or `undefined` when it does not parse. */
function canonicalInstant(date: string): string | undefined {
  // Git's `%cI` text spells UTC as `Z` on some versions and `+00:00` on others; one canonical instant keeps a fixed
  // repository's answer byte-identical across machines. Parsing a recorded date never reads the clock.
  const instant = new Date(date.trim());
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/**
 * Reads every file's last commit under `root` with one `git log`, newest first, so a site of 600 pages costs one
 * process instead of 600. The newest commit that names a path is the one `git log -1 -- <path>` would give.
 * A failure, including a missing git, is `undefined` rather than an empty map: git did not answer, so a page must
 * read {@link UNKNOWN} and coverage must be `unavailable`, not the `untracked` an empty map would imply.
 */
function readReviews(root: string): Map<string, Review> | undefined {
  let text: string;
  try {
    // `--relative` with `-- .` limits the log to `root` and names files relative to it; `-z` keeps odd names unquoted.
    text = execFileSync("git", ["log", "--relative", "--format=%x01%cI%x02%aN", "--name-only", "-z", "--", "."], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }

  const reviews = new Map<string, Review>();

  // Each record is `\x01 date \x02 author NUL \n file NUL file NUL ...`; the author never holds a NUL or \x01.
  for (const record of text.split("\x01")) {
    const [head = "", ...files] = record.split("\0");
    const [date = "", author = ""] = head.split("\x02");
    const trimmedAuthor = author.trim();
    const instant = canonicalInstant(date);
    if (instant === undefined || trimmedAuthor === "") continue;
    for (const file of files) {
      const path = file.replace(/^\r?\n/, "");
      if (path !== "" && !reviews.has(path)) reviews.set(path, { date: instant, author: trimmedAuthor });
    }
  }
  return reviews;
}

/**
 * How much review history a page has: `recorded` when git names a commit for it, `untracked` when the root is a
 * work tree but no commit names it, and `unavailable` when git, a work tree, or a path inside the root is missing.
 * The three are kept apart so a consumer can tell "never committed" from "git cannot be asked".
 */
export type ReviewCoverage = "recorded" | "untracked" | "unavailable";

/** The path and history to ask about, or `undefined` when the path is unanswered or the root is not a work tree. */
function historyOf(
  root: string,
  pageFile: string,
): { readonly base: string; readonly history: History; readonly path: string } | undefined {
  const base = resolve(root);
  const path = gitPathOf(base, pageFile);
  if (path === undefined) return undefined;

  const history = historyAt(base);
  return history.available ? { base, history, path } : undefined;
}

/**
 * The last commit that touched `pageFile`, as its committer date and author name, for the "last reviewed by" line.
 * `pageFile` is relative to `root` (or absolute inside it); a path outside the root is {@link UNKNOWN}, never another
 * file's history.
 *
 * The answer comes from `git log --format=%cI%x02%aN --name-only` (the newest commit naming the path), so `%aN` applies the repository's `.mailmap`.
 * The date is the commit instant in UTC, so git's choice of `Z` or `+00:00` is not visible. A root outside a git work
 * tree, a file git has never seen, and a missing git all read {@link UNKNOWN}; this function never throws and never
 * reads the clock. Each root is read once per process and then cached, so a fixed repository gives the
 * same answer every time while a commit made later in the same process is not seen.
 *
 * This is a machine input: the answer depends on the repository's history and `.mailmap`, which are not part of the
 * site's source. A copy of the site without its history reports {@link UNKNOWN}; a build on a machine without git
 * does too.
 */
export function reviewers(root: string, pageFile: string): ReviewLookup {
  const found = historyOf(root, pageFile);
  if (found === undefined) return UNKNOWN;

  const reviews = (found.history.reviews ??= readReviews(found.base));
  return reviews?.get(found.path) ?? UNKNOWN;
}

/**
 * What git knows about `pageFile`, without inventing a review: see {@link ReviewCoverage}. The path rules and the
 * per-root cache are the ones {@link reviewers} uses, so asking both costs one `git log` and the two answers agree.
 * A path outside the root is `unavailable`, because no history for it may be read.
 */
export function reviewCoverage(root: string, pageFile: string): ReviewCoverage {
  const found = historyOf(root, pageFile);
  if (found === undefined) return "unavailable";

  const reviews = (found.history.reviews ??= readReviews(found.base));
  if (reviews === undefined) return "unavailable";
  return reviews.has(found.path) ? "recorded" : "untracked";
}

/** One commit that names a page, with the two facts a review policy counts. */
export interface ReviewCommit {
  /** The committer instant in UTC ISO 8601, canonical like {@link Review.date}. */
  readonly date: string;
  /** The mailmap author name (`%aN`). Two spellings that map to one name are one reviewer. */
  readonly author: string;
}

/** The closed window a review policy asks about: `since` and `until` are both included. */
export interface ReviewWindow {
  /** The first instant included in the window. */
  readonly since: Date;
  /** The last instant included in the window; the explicit as-of. */
  readonly until: Date;
}

/** What git knows about one page inside a review window. */
export interface PageReviewHistory {
  /** `recorded` when any commit names the page, `untracked` when none does, `unavailable` when git could not answer. */
  readonly coverage: ReviewCoverage;
  /** Commits in the window, newest first. Empty when the page is untracked, unavailable, or only older. */
  readonly commits: readonly ReviewCommit[];
  /** The distinct mailmap author names in `commits`, in code-point order. */
  readonly reviewers: readonly string[];
  /** The last commit that names the page, when one exists; it can be older than the window. */
  readonly lastReview?: ReviewCommit;
}

/** What one bounded root log found: commits per path, so later pages of the same root read it from memory. */
interface WindowHistory {
  /** Commits per root-relative path, or `undefined` when git did not answer. */
  readonly commits: Map<string, ReviewCommit[]> | undefined;
}

/** One bounded history per root and window, so two pages with the same window pay for one `git log`. */
const WINDOWS = new Map<string, WindowHistory>();

/** Compares commits newest first, then by author, so a fixed repository always returns the same order. */
function newestFirst(a: ReviewCommit, b: ReviewCommit): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
}

/**
 * Reads every commit in `[since, until]` under `root` with one bounded `git log`, newest first. The lower
 * boundary is widened by one second for git's date parsing and the result is filtered exactly, so a commit
 * on either boundary is included. A failure, including a missing git, is `undefined`: the window was not
 * read, which is not the same as a window with no commits.
 */
function readWindow(root: string, since: number, until: number): Map<string, ReviewCommit[]> | undefined {
  let text: string;
  try {
    // `--relative` with `-- .` limits the log to `root`. `--since-as-filter` drops older commits without
    // stopping at the first old one, so a commit with a skewed date cannot hide newer ancestors. The upper
    // bound is applied in memory rather than with `--until`, which also assumes date-ordered history.
    // shortcut: --since-as-filter needs Git 2.37+; older git reads the window as unavailable, never wrong.
    text = execFileSync(
      "git",
      [
        "log",
        "--relative",
        "--format=%x01%cI%x02%aN",
        "--name-only",
        "-z",
        `--since-as-filter=${new Date(since - 1000).toISOString()}`,
        "--",
        ".",
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return undefined;
  }

  const commits = new Map<string, ReviewCommit[]>();

  // Each record is `\x01 date \x02 author NUL \n file NUL file NUL ...`; the author never holds a NUL or \x01.
  for (const record of text.split("\x01")) {
    const [head = "", ...files] = record.split("\0");
    const [date = "", author = ""] = head.split("\x02");
    const trimmedAuthor = author.trim();
    const instant = canonicalInstant(date);
    if (instant === undefined || trimmedAuthor === "") continue;
    const millis = new Date(instant).getTime();
    if (millis < since || millis > until) continue;

    for (const file of files) {
      const path = file.replace(/^\r?\n/, "");
      if (path === "") continue;
      const list = commits.get(path);
      if (list === undefined) commits.set(path, [{ date: instant, author: trimmedAuthor }]);
      else list.push({ date: instant, author: trimmedAuthor });
    }
  }

  for (const list of commits.values()) list.sort(newestFirst);
  return commits;
}

/** The bounded history of one root and window, read once and cached for the life of the process. */
function windowAt(root: string, since: number, until: number): Map<string, ReviewCommit[]> | undefined {
  const key = `${root}\0${since}\0${until}`;
  const found = WINDOWS.get(key);
  if (found !== undefined) return found.commits;
  const commits = readWindow(root, since, until);
  WINDOWS.set(key, { commits });
  return commits;
}

/** The distinct author names of a commit list, in code-point order. */
function authorsOf(commits: readonly ReviewCommit[]): readonly string[] {
  return [...new Set(commits.map((commit) => commit.author))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What git knows about `pageFile` inside `window`: the commits in the window, the distinct mailmap authors
 * among them, and the last review even when it is older than the window. The window is read with one
 * bounded `git log` per root, shared by every page asking about the same window. A page with no commit in
 * the window is classified by the per-root last-commit cache {@link reviewers} already keeps: a page with
 * an older commit is `recorded` (the caller can call it overdue), and a page no commit names is
 * `untracked`. A path outside the root, a root outside a work tree, and a failed log all read
 * `unavailable`, never as an empty history that would pass.
 *
 * The dates come from `%cI` and the names from `%aN`, so the repository's `.mailmap` decides identity. A
 * fixed root and window give the same answer, and each root and window is read once per process.
 */
export function reviewHistory(root: string, pageFile: string, window: ReviewWindow): PageReviewHistory {
  const since = window.since.getTime();
  const until = window.until.getTime();
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
    return { coverage: "unavailable", commits: [], reviewers: [] };
  }

  const found = historyOf(root, pageFile);
  if (found === undefined) return { coverage: "unavailable", commits: [], reviewers: [] };

  const byPath = windowAt(found.base, since, until);
  if (byPath === undefined) return { coverage: "unavailable", commits: [], reviewers: [] };

  const commits = byPath.get(found.path) ?? [];
  if (commits.length > 0) {
    return {
      coverage: "recorded",
      commits,
      reviewers: authorsOf(commits),
      lastReview: commits[0]!,
    };
  }

  // Nothing in the window: one cached read of the whole root still says whether any commit ever names it.
  const last = reviewers(found.base, found.path);
  if (last !== UNKNOWN) {
    return { coverage: "recorded", commits: [], reviewers: [], lastReview: last };
  }
  return { coverage: reviewCoverage(found.base, found.path), commits: [], reviewers: [] };
}
