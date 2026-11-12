import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

/**
 * The limits every git call in this module is held to. Review evidence is an input, not something a build may wait
 * on forever: a command that misses the deadline is killed, and a log that outgrows the cap is discarded rather
 * than buffered. Either way the lookup reads as unavailable, never as stale or successful evidence.
 */
/** The deadline of one git call, in milliseconds. */
const GIT_TIMEOUT_MS = 10_000;

/** The most stdout one git call may produce. A whole-root log of 600 pages fits far below it. */
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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

/**
 * The repository state a cache entry belongs to. One `git rev-parse` answers both parts, so a lookup can tell whether
 * the repository moved since an entry was made without reading the clock: HEAD, not time, decides freshness, and the
 * no-clock contract holds.
 */
interface RepoState {
  /** True when git answers and the root is inside a work tree; only then may a history be trusted. */
  readonly available: boolean;
  /** The commit HEAD names, or `""` when the repository has no commit yet. */
  readonly head: string;
}

/** What a repository costs, for one state: one `git rev-parse`, at most one `git log` for the whole root, and one per window. */
interface Cache {
  /** The resolved root every git call for this cache runs in. */
  readonly base: string;
  /** The key of the state this cache was made from; a live key that differs replaces the whole cache, windows included. */
  readonly key: string;
  /** True when this cache's state is a work tree, so the history below may be read at all. */
  readonly available: boolean;
  /** Reviews by root-relative path (forward slashes) for this state, read by one `git log` on the first lookup; `undefined` until then. */
  reviews: Map<string, Review> | undefined;
  /** Bounded window logs for this state, one per window; none of them survives a state change. */
  readonly windows: Map<string, WindowHistory>;
}

/** One cache per resolved root, usable only while its key still names the repository's state. */
const CACHES = new Map<string, Cache>();

/** The cache key of a state, so one key per repository state and no entry can be read under another HEAD. */
function stateKeyOf(state: RepoState): string {
  return `${state.available ? "work" : "none"}\0${state.head}`;
}

/** The stdout a failing git still wrote, which is what separates a repository with no commit from a folder git ignores. */
function stdoutOf(error: unknown): string {
  // Only a git that exited on its own wrote a complete answer; a timeout, an overflow, or a spawn failure left a
  // partial buffer, and a partial "true" must not become a repository state.
  if (typeof (error as { readonly status?: unknown }).status !== "number") return "";
  const stdout = (error as { readonly stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}

/**
 * Asks git once whether `root` is inside a work tree and which commit HEAD names. A missing git, a folder outside a
 * work tree, a repository with no commit yet, and a call that misses the git deadline all give a state no history may
 * be trusted for. The state is read on every lookup, so a `git init`, a first commit, or a later commit is seen in the
 * same process as in a new one.
 */
function stateOf(root: string): RepoState {
  let text: string;
  try {
    // `HEAD` does not resolve before the first commit, so git exits non-zero while still printing the work-tree answer.
    text = execFileSync("git", ["rev-parse", "--is-inside-work-tree", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    text = stdoutOf(error);
  }

  const [workTree = "", head = ""] = text.split(/\r?\n/);
  const trimmedHead = head.trim();
  return {
    available: workTree.trim() === "true",
    head: /^[0-9a-f]{7,40}$/.test(trimmedHead) ? trimmedHead : "",
  };
}

/**
 * The cache for `root`'s current state. An unchanged state reuses the same cache, so a whole-root log and each window
 * log happen once for it; a state change — a commit, a repository appearing, or one disappearing — replaces the cache
 * whole. One state therefore answers last-review, coverage, and window lookups together, so they cannot disagree.
 */
function cacheAt(root: string): Cache {
  const state = stateOf(root);
  const key = stateKeyOf(state);
  const found = CACHES.get(root);
  if (found !== undefined && found.key === key) return found;

  const cache: Cache = {
    base: root,
    key,
    available: state.available,
    reviews: undefined,
    windows: new Map(),
  };
  CACHES.set(root, cache);
  return cache;
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
 * A failure, including a missing git, a missed deadline, or more output than the cap, is `undefined` rather than an
 * empty map: git did not answer, so a page must read {@link UNKNOWN} and coverage must be `unavailable`, not the
 * `untracked` an empty map would imply.
 */
function readReviews(root: string): Map<string, Review> | undefined {
  let text: string;
  try {
    // `--relative` with `-- .` limits the log to `root` and names files relative to it; `-z` keeps odd names unquoted.
    text = execFileSync("git", ["log", "--relative", "--format=%x01%cI%x02%aN", "--name-only", "-z", "--", "."], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
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

/** The path and the current state's cache to ask about, or `undefined` when the path is unanswered or the state is not a work tree. */
function historyOf(
  root: string,
  pageFile: string,
): { readonly cache: Cache; readonly path: string } | undefined {
  const base = resolve(root);
  const path = gitPathOf(base, pageFile);
  if (path === undefined) return undefined;

  const cache = cacheAt(base);
  return cache.available ? { cache, path } : undefined;
}

/** The whole-root reviews of a cache, read by one `git log` the first time this state is asked about. */
function reviewsOf(cache: Cache): Map<string, Review> | undefined {
  return (cache.reviews ??= readReviews(cache.base));
}

/**
 * The last commit that touched `pageFile`, as its committer date and author name, for the "last reviewed by" line.
 * `pageFile` is relative to `root` (or absolute inside it); a path outside the root is {@link UNKNOWN}, never another
 * file's history.
 *
 * The answer comes from `git log --format=%cI%x02%aN --name-only` (the newest commit naming the path), so `%aN` applies the repository's `.mailmap`.
 * The date is the commit instant in UTC, so git's choice of `Z` or `+00:00` is not visible. A root outside a git work
 * tree, a file git has never seen, a missing git, and a call that misses its deadline or output cap all read
 * {@link UNKNOWN}; this function never throws and never reads the clock. Each root is read once per repository state,
 * so a fixed repository gives the same answer every time while a commit made later in the same process is seen by the
 * next call.
 *
 * This is a machine input: the answer depends on the repository's history and `.mailmap`, which are not part of the
 * site's source. A copy of the site without its history reports {@link UNKNOWN}; a build on a machine without git
 * does too.
 */
export function reviewers(root: string, pageFile: string): ReviewLookup {
  const found = historyOf(root, pageFile);
  if (found === undefined) return UNKNOWN;

  const reviews = reviewsOf(found.cache);
  return reviews?.get(found.path) ?? UNKNOWN;
}

/**
 * What git knows about `pageFile`, without inventing a review: see {@link ReviewCoverage}. The path rules and the
 * per-state cache are the ones {@link reviewers} uses, so asking both costs one `git log` and the two answers agree.
 * A path outside the root is `unavailable`, because no history for it may be read.
 */
export function reviewCoverage(root: string, pageFile: string): ReviewCoverage {
  const found = historyOf(root, pageFile);
  if (found === undefined) return "unavailable";

  const reviews = reviewsOf(found.cache);
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

/** What one bounded root log found: commits per path, so later pages of the same state read it from memory. */
interface WindowHistory {
  /** Commits per root-relative path, or `undefined` when git did not answer. */
  readonly commits: Map<string, ReviewCommit[]> | undefined;
}

/** Compares commits newest first, then by author, so a fixed repository always returns the same order. */
function newestFirst(a: ReviewCommit, b: ReviewCommit): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
}

/**
 * Reads every commit in `[since, until]` under `root` with one bounded `git log`, newest first. The lower
 * boundary is widened by one second for git's date parsing and the result is filtered exactly, so a commit
 * on either boundary is included. A failure, including a missing git, a missed deadline, or more output than
 * the cap, is `undefined`: the window was not read, which is not the same as a window with no commits.
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
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
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

/**
 * The bounded history of one window of one state, read once per state so two pages with the same window pay for one
 * `git log`. The cache is the state's, so a window entry cannot be read under another HEAD.
 */
function windowOf(cache: Cache, since: number, until: number): Map<string, ReviewCommit[]> | undefined {
  const key = `${since}\0${until}`;
  const found = cache.windows.get(key);
  if (found !== undefined) return found.commits;
  const commits = readWindow(cache.base, since, until);
  cache.windows.set(key, { commits });
  return commits;
}

/** The distinct author names of a commit list, in code-point order. */
function authorsOf(commits: readonly ReviewCommit[]): readonly string[] {
  return [...new Set(commits.map((commit) => commit.author))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What git knows about `pageFile` inside `window`: the commits in the window, the distinct mailmap authors
 * among them, and the last review even when it is older than the window. The window is read with one
 * bounded `git log` per root and state, shared by every page asking about the same window. A page with no commit in
 * the window is classified by the whole-root last-commit history the same state already keeps: a page with
 * an older commit is `recorded` (the caller can call it overdue), and a page no commit names is
 * `untracked`. A path outside the root, a root outside a work tree, and a failed log all read
 * `unavailable`, never as an empty history that would pass.
 *
 * The dates come from `%cI` and the names from `%aN`, so the repository's `.mailmap` decides identity. A
 * fixed root, state, and window give the same answer, and each state is read once per window. When HEAD moves, the
 * window, the last review, and {@link reviewCoverage} are all read from the new state, so they cannot name commits
 * from two different repository states.
 */
export function reviewHistory(root: string, pageFile: string, window: ReviewWindow): PageReviewHistory {
  const since = window.since.getTime();
  const until = window.until.getTime();
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
    return { coverage: "unavailable", commits: [], reviewers: [] };
  }

  const found = historyOf(root, pageFile);
  if (found === undefined) return { coverage: "unavailable", commits: [], reviewers: [] };

  const byPath = windowOf(found.cache, since, until);
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

  // Nothing in the window: the same state's whole-root history still says whether any commit ever names the page,
  // so a last review, a coverage answer, and a window never come from two different HEADs.
  const reviews = reviewsOf(found.cache);
  if (reviews === undefined) return { coverage: "unavailable", commits: [], reviewers: [] };
  const last = reviews.get(found.path);
  if (last !== undefined) {
    return { coverage: "recorded", commits: [], reviewers: [], lastReview: last };
  }
  return { coverage: "untracked", commits: [], reviewers: [] };
}
