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
 * Any failure, including a missing git, is an empty map, so every page reads {@link UNKNOWN}.
 */
function readReviews(root: string): Map<string, Review> {
  const reviews = new Map<string, Review>();
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
    return reviews;
  }

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

  found.history.reviews ??= readReviews(found.base);
  return found.history.reviews.get(found.path) ?? UNKNOWN;
}

/**
 * What git knows about `pageFile`, without inventing a review: see {@link ReviewCoverage}. The path rules and the
 * per-root cache are the ones {@link reviewers} uses, so asking both costs one `git log` and the two answers agree.
 * A path outside the root is `unavailable`, because no history for it may be read.
 */
export function reviewCoverage(root: string, pageFile: string): ReviewCoverage {
  const found = historyOf(root, pageFile);
  if (found === undefined) return "unavailable";

  found.history.reviews ??= readReviews(found.base);
  return found.history.reviews.has(found.path) ? "recorded" : "untracked";
}
