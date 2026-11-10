import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { fallbackChain, languageGroups } from "../content/lang-fallback.ts";

/** The file this output writes, relative to the output folder. */
const FILE = "translations.json";

/** What one page is, or is not, in one configured language. */
export type TranslationStatus = "fallback" | "missing" | "stale" | "translated";

/** One page and one configured language. */
export interface TranslationRecord {
  /** The source page's URL, including `base`. */
  readonly url: string;
  /** The configured language code this status is about. */
  readonly lang: string;
  /** Whether that language has a page, a stand-in, an out-of-date page, or none. */
  readonly status: TranslationStatus;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A language tag in the form matching compares: trimmed, lower case, `_` read as `-`. Mirrors N37 (`content/lang-fallback.ts`). */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** The tag and each shorter form: `pt-BR-x` → `["pt-br-x", "pt-br", "pt"]`. Mirrors N37 (`content/lang-fallback.ts`). */
function tagChain(tag: string): readonly string[] {
  const parts = normalizeTag(tag).split("-").filter((part) => part !== "");
  const chain: string[] = [];
  for (let length = parts.length; length > 0; length--) chain.push(parts.slice(0, length).join("-"));
  return chain;
}

/** The first page in `group` whose language is exactly `tag`, compared case-insensitively. */
function findTag(group: readonly Page[], tag: string): Page | undefined {
  const wanted = normalizeTag(tag);
  return group.find((page) => normalizeTag(page.lang) === wanted);
}

/** The page a group is written from: the first fallback language with a page, else the group's first page. */
function sourceOf(group: readonly Page[], site: Site): Page {
  for (const language of fallbackChain(site.config, site.data)) {
    for (const tag of tagChain(language)) {
      const found = findTag(group, tag);
      if (found !== undefined) return found;
    }
  }
  return group[0]!;
}

/**
 * A `last_modified_at` value as a date: the front matter schema allows a date, or a date and a time with an optional
 * offset. A time without an offset is UTC, so a build gives the same bytes in every time zone. A value that is not a
 * real calendar date reads as no date.
 */
function dateOfValue(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string") return undefined;

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?( ?(?:Z|[+-]\d{2}:?\d{2}))?)?$/.exec(
    value.trim(),
  );
  if (match === null) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "", zoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? "0");
  const minute = Number(minuteText ?? "0");
  const second = Number(secondText ?? "0");

  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  let zone = zoneText?.replace(/\s/g, "") ?? "Z";
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const fractional = fractionText.padEnd(3, "0").slice(0, 3);
  const date = new Date(`${yearText}-${monthText}-${dayText}T${hourText ?? "00"}:${minuteText ?? "00"}:${secondText ?? "00"}.${fractional}${zone}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `value` shaped as `/folder` with no leading `./` and no trailing slash; `""` at the repository root. */
function folderOf(value: string | undefined): string {
  const folder = (value ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return folder === "." ? "" : folder;
}

/**
 * The paths a page's source may have on disk, most specific first: relative to the site root (the repository's
 * `dir` prefix removed), then exactly as the model names it. Only a path that exists under the root is used.
 */
function sourceCandidates(page: Page, site: Site): string[] {
  const file = page.source.file;
  const repositoryDir = folderOf(site.config.repository?.dir);
  const candidates = repositoryDir !== "" && file.startsWith(`${repositoryDir}/`)
    ? [file.slice(repositoryDir.length + 1), file]
    : [file];
  return [...new Set(candidates)];
}

/**
 * What a page's git date costs: one work-tree check for the build, and one cheap `git log` per source file, cached.
 * The helpers below are copied from `feed.ts` (which owns the same logic) so this output can ship in parallel;
 * moving them into one shared module is a later refactor and changes no behaviour.
 */
interface GitDates {
  /** True when `root` is inside a git work tree; the dates in this object are trusted only then. */
  readonly available: boolean;
  /** The folder git runs in, which is where the page paths are resolved from. */
  readonly root: string;
  /** `%cI` dates by page path, so one file is asked about once. */
  readonly cache: Map<string, Date | undefined>;
}

/** Checks once whether `root` is inside a work tree, so a site outside git never pays for `git log` per page. */
function gitDatesAt(root: string): GitDates {
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
  return { available, root, cache: new Map() };
}

/** The committer date of the last commit that touched `path`, as a date; `undefined` when git has no answer. */
function gitDateOf(dates: GitDates, path: string): Date | undefined {
  if (dates.cache.has(path)) return dates.cache.get(path);
  let date: Date | undefined;
  try {
    const text = execFileSync("git", ["log", "-1", "--format=%cI", "--", path], {
      cwd: dates.root,
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
  dates.cache.set(path, date);
  return date;
}

/**
 * The page's source date: the committer date of the last commit that touched its source file when the site root is
 * inside a git work tree, else `last_modified_at` from its front matter. Staleness therefore uses git history when it
 * is there, as the issue asks, and still works for a site outside git. A page with neither has no date.
 */
function dateOfPage(page: Page, site: Site, git: GitDates): Date | undefined {
  if (git.available) {
    for (const candidate of sourceCandidates(page, site)) {
      if (!existsSync(resolve(git.root, candidate))) continue;
      const date = gitDateOf(git, candidate);
      if (date !== undefined) return date;
    }
  }
  return dateOfValue(page.frontMatter.last_modified_at);
}

/** `true` when `page` has a date and it is strictly older than the source page's date. */
function isStale(page: Page, source: Page, site: Site, git: GitDates): boolean {
  if (page === source) return false;
  const date = dateOfPage(page, site, git);
  const sourceDate = dateOfPage(source, site, git);
  if (date === undefined || sourceDate === undefined) return false;
  return date.getTime() < sourceDate.getTime();
}

/** The status of one configured language in one group. */
function statusOf(group: readonly Page[], lang: string, site: Site, source: Page, git: GitDates): TranslationStatus {
  for (const tag of tagChain(lang)) {
    const found = findTag(group, tag);
    if (found !== undefined) {
      if (normalizeTag(found.lang) !== normalizeTag(lang)) return "fallback";
      return isStale(found, source, site, git) ? "stale" : "translated";
    }
  }

  for (const language of fallbackChain(site.config, site.data)) {
    for (const tag of tagChain(language)) {
      if (findTag(group, tag) !== undefined) return "fallback";
    }
  }

  return "missing";
}

/**
 * Writes `translations.json`: one record per doc page and configured language, sorted by URL then language code, so
 * the same model gives the same bytes. The page is the group's source page (its URL is the record's `url`): the first
 * page in `_data/languages.yml`'s fallback chain, else the group's first page. A language's status is:
 *
 * - `translated`: the group has a real page exactly in that language;
 * - `stale`: like `translated`, but the page's source date is strictly older than the source page's (see
 *   {@link dateOfPage}, which reads git history first and `last_modified_at` second);
 * - `fallback`: no page in that language, but N37's fallback rules find one in another (a shorter tag such as
 *   `pt-BR` → `pt`, or a `_data/languages.yml` chain entry);
 * - `missing`: N37 finds no page at all.
 *
 * App pages and assets are not translations and are left out. A site with no configured `languages` writes no file:
 * the output returns no files rather than an empty array, so `translations.json` exists only for a multilingual site.
 */
export async function translationsFile(site: Site, root: string = process.cwd()): Promise<readonly OutputFile[]> {
  const docs = site.pages.filter((page) => page.kind === "doc");
  const languages = [...new Set(site.config.languages.map((language) => language.code))];
  if (languages.length === 0 || docs.length === 0) return [];

  const git = gitDatesAt(root);
  const records: TranslationRecord[] = [];
  const groups = languageGroups({ ...site, pages: docs });

  for (const group of groups.values()) {
    const source = sourceOf(group, site);
    for (const lang of languages) {
      records.push({ url: source.url, lang, status: statusOf(group, lang, site, source, git) });
    }
  }

  records.sort((a, b) => byCodePoint(a.url, b.url) || byCodePoint(a.lang, b.lang));
  return [{ path: FILE, contents: `${JSON.stringify(records, null, 2)}\n` }];
}

/** The `translations` output: translation status per page and configured language. */
export const translations: Output = {
  name: "translations",
  async run(site: Site): Promise<readonly OutputFile[]> {
    return translationsFile(site);
  },
};
