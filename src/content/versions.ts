import type { Page } from "../contracts/index.ts";

/**
 * Versioned documentation folders.
 *
 * A docs site often keeps one folder per version, as in `docs/v1/guide/install.md` and
 * `docs/v2/guide/install.md`. This module reads the site model's pages and places each one in its version,
 * so an output or a layout can pair a page with the same page in another version.
 *
 * ## The detection rule
 *
 * A page's **version folder** is one path segment, taken from `page.source.file` (never from `page.url`,
 * because a `permalink` may hide the folder):
 *
 * 1. The first segment when the file starts with it: `v2/guide/install.md` → `v2`.
 * 2. Otherwise, the first segment after the longest match of `options.roots`: with `roots: ["docs"]`,
 *    `docs/v2/guide/install.md` → `v2`; with `roots: ["docs", "docs/guide"]`,
 *    `docs/guide/v2/install.md` → `v2`.
 *
 * The segment counts as a version only when it matches `/^v\d+(?:\.\d+){0,2}$/` (`v1`, `v1.2`, `v1.2.3`),
 * or when `options.versions` supplies the folder names. A supplied list is also the order versions are
 * sorted in, and it restricts detection to those names; names are matched exactly. An empty list is treated
 * as missing. The site config schema is frozen (ADR 0024), so a caller that keeps the list in config passes
 * it here as an option rather than changing the schema.
 *
 * A page outside every version gets `version: null` and keeps its whole source path. It is returned, not
 * omitted, so a caller can render the current docs and the versioned docs from one list.
 *
 * ## Renames
 *
 * `options.renames` maps a path inside a version folder to the path the page has in another version, so
 * `v1/old-name.md` and `v2/new-name.md` compare as one page:
 *
 * ```ts
 * discoverVersions(pages, { renames: [{ from: "old-name.md", to: "new-name.md" }] });
 * ```
 *
 * The first matching rename wins; a rename with `version` applies only to that version. Paths are exact,
 * with no directory-prefix or chain resolution.
 *
 * ## Added and removed
 *
 * When two or more versions are detected, each versioned page is compared with the newest version (the last
 * one in version order):
 *
 * - `added`: the page is in the newest version and in no older one.
 * - `removed`: the page is not in the newest version.
 * - no status: the page is unchanged across versions, it is unversioned, or only one version exists.
 *
 * The function reports nothing and takes no diagnostics; an empty result or an unversioned page is valid
 * input, not a problem.
 */

/** The page fields this module reads. A full `Page` satisfies it. */
export type VersionPage = Pick<Page, "source" | "url">;

/** How a versioned page differs from the newest version. */
export type VersionStatus = "added" | "removed";

/** A page renamed between versions, by its path inside a version folder. */
export interface VersionRename {
  /** The path before the rename, such as `guide/old-name.md`. */
  readonly from: string;
  /** The path after the rename, such as `guide/new-name.md`. */
  readonly to: string;
  /** The version `from` belongs to; omitted applies the rename in every version. */
  readonly version?: string;
}

/** Options of {@link discoverVersions}. */
export interface VersionOptions {
  /**
   * Documentation roots under the source folder, such as `["docs"]`. A version folder is the first segment
   * after the longest matching root. Without a root, only the first segment of a source path is examined.
   */
  readonly roots?: readonly string[];
  /**
   * The version folder names, in sort order, when the `vN` rule does not describe the site. Supplying it
   * also restricts detection to these names, so a folder such as `v3` is ignored when it is not listed.
   */
  readonly versions?: readonly string[];
  /** Pages renamed between versions, so the old and new paths compare as one page. */
  readonly renames?: readonly VersionRename[];
}

/** One page with the version it belongs to and its path inside that version. */
export interface VersionedPage<P extends VersionPage = Page> {
  /** The page the entry was made from. */
  readonly page: P;
  /** The version folder, such as `v2`, or `null` when the page is outside every version. */
  readonly version: string | null;
  /** The source path with the version folder removed and any rename applied, such as `guide/install.md`. */
  readonly path: string;
  /** How the page differs from the newest version; unset when it does not. */
  readonly status?: VersionStatus;
}

/** The `vN` naming rule: one, two, or three numeric parts. */
const VERSION_NAME = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A path as its non-empty segments, with either slash accepted. */
function segmentsOf(path: string): readonly string[] {
  return path
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** The `/`-joined form of a path without a leading or trailing slash. */
function normalizePath(path: string): string {
  return segmentsOf(path).join("/");
}

/** The numeric parts of `vN`, `vN.M`, or `vN.M.P`, or `undefined` for any other name. */
function versionNumbers(name: string): readonly number[] | undefined {
  const match = VERSION_NAME.exec(name);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** The number of segments of the longest root that prefixes `segments`. */
function rootLength(segments: readonly string[], roots: readonly (readonly string[])[]): number {
  let length = 0;
  for (const root of roots) {
    if (root.length <= length) continue;
    if (root.every((part, index) => segments[index] === part)) length = root.length;
  }
  return length;
}

/** The version folder and remaining path a source file names, or `undefined` outside every version. */
function locate(
  file: string,
  roots: readonly (readonly string[])[],
  versions: readonly string[] | undefined,
): { readonly version: string; readonly path: string } | undefined {
  const segments = segmentsOf(file);
  const start = rootLength(segments, roots);
  const candidate = segments[start];
  if (candidate === undefined) return undefined;
  const known = versions !== undefined ? versions.includes(candidate) : VERSION_NAME.test(candidate);
  if (!known) return undefined;
  return { version: candidate, path: segments.slice(start + 1).join("/") };
}

/** The canonical path with the first applicable rename applied; the path itself when none applies. */
function rename(version: string, path: string, renames: readonly VersionRename[]): string {
  for (const entry of renames) {
    if (entry.version !== undefined && entry.version !== version) continue;
    if (entry.from === path) return entry.to;
  }
  return path;
}

/** Compare two version names: the supplied order when given, else numeric parts, then code points. */
function compareVersions(a: string, b: string, order: readonly string[] | undefined): number {
  if (order !== undefined) {
    const difference = order.indexOf(a) - order.indexOf(b);
    if (difference !== 0) return difference;
  }
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  if (left !== undefined && right !== undefined) {
    for (let index = 0; index < left.length; index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
  }
  return byCodePoint(a, b);
}

/** The version names the pages use, in version order; empty when no page is versioned. */
function versionOrder(
  entries: readonly { readonly version: string | null }[],
  supplied: readonly string[] | undefined,
): readonly string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.version !== null) found.add(entry.version);
  }
  return [...found].sort((a, b) => compareVersions(a, b, supplied));
}

/** The canonical paths each version holds. */
function pathsByVersion(
  entries: readonly { readonly version: string | null; readonly path: string }[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.version === null) continue;
    const paths = map.get(entry.version);
    if (paths === undefined) map.set(entry.version, new Set([entry.path]));
    else paths.add(entry.path);
  }
  return map;
}

/** The status of one page against the newest version, or `undefined` when it carries none. */
function statusOf(
  version: string,
  path: string,
  versions: readonly string[],
  paths: ReadonlyMap<string, ReadonlySet<string>>,
): VersionStatus | undefined {
  if (versions.length < 2) return undefined;
  const newest = versions[versions.length - 1];
  if (newest === undefined) return undefined;
  const newestPaths = paths.get(newest);
  if (version === newest) {
    const older = versions.slice(0, -1).some((other) => paths.get(other)?.has(path) === true);
    return older ? undefined : "added";
  }
  return newestPaths?.has(path) === true ? undefined : "removed";
}

/**
 * Place every page in its documentation version.
 *
 * The result is sorted by version (numeric, or the order of `options.versions`) then by the path inside the
 * version, then by source file so that pages which collapse to one path through a rename keep a stable order.
 * Pages outside a version come last, sorted by path. The function never reads the clock or the environment, so
 * the same pages always give the same result.
 */
export function discoverVersions<P extends VersionPage>(
  pages: readonly P[],
  options: VersionOptions = {},
): readonly VersionedPage<P>[] {
  const roots = (options.roots ?? []).map(segmentsOf).filter((root) => root.length > 0);
  const supplied = options.versions?.map(normalizePath).filter((name) => name !== "");
  const order = supplied !== undefined && supplied.length > 0 ? supplied : undefined;
  const renames = (options.renames ?? [])
    .map(
      (entry): VersionRename => ({
        from: normalizePath(entry.from),
        to: normalizePath(entry.to),
        ...(entry.version === undefined ? {} : { version: entry.version }),
      }),
    )
    .filter((entry) => entry.from !== "" && entry.to !== "");

  const placed = pages.map((page) => {
    const found = locate(page.source.file, roots, order);
    if (found === undefined) return { page, version: null, path: normalizePath(page.source.file) };
    return { page, version: found.version, path: rename(found.version, found.path, renames) };
  });

  const versions = versionOrder(placed, order);
  const paths = pathsByVersion(placed);

  const withStatus: VersionedPage<P>[] = placed.map((entry) => {
    if (entry.version === null) return entry;
    const status = statusOf(entry.version, entry.path, versions, paths);
    return status === undefined ? entry : { ...entry, status };
  });

  return withStatus.sort((a, b) => {
    if (a.version === null && b.version !== null) return 1;
    if (a.version !== null && b.version === null) return -1;
    if (a.version !== null && b.version !== null) {
      const difference = compareVersions(a.version, b.version, order);
      if (difference !== 0) return difference;
    }
    return byCodePoint(a.path, b.path) || byCodePoint(a.page.source.file, b.page.source.file);
  });
}
