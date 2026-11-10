import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The feed's file name, relative to the output folder. */
const FILE = "changes.xml";

/** How many of the most recently changed pages the feed carries. */
const LIMIT = 30;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escapes the five characters XML reserves, so any title or URL can sit inside an element or an attribute. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The scheme and host absolute URLs start with, from `url` in the site config; `undefined` when it is missing or not absolute. */
function originOf(site: Site): string | undefined {
  const url = site.config.url?.trim() ?? "";
  if (url === "") return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
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
 * `dir` prefix removed), then exactly as the model names it. Only a path that exists under the root is used, so a
 * build from a folder that merely shares a name with a site file never borrows another file's date.
 */
function sourceCandidates(page: Page, site: Site): string[] {
  const file = page.source.file;
  const repositoryDir = folderOf(site.config.repository?.dir);
  const candidates = repositoryDir !== "" && file.startsWith(`${repositoryDir}/`)
    ? [file.slice(repositoryDir.length + 1), file]
    : [file];
  return [...new Set(candidates)];
}

/** What a page's git date costs: one work-tree check for the build, and one cheap `git log` per source file, cached. */
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
 * The page's last change: `last_modified_at` from front matter, else the last commit that touched its source file
 * when the site root is inside a git work tree. A page with neither has no date and is left out.
 */
function dateOfPage(page: Page, site: Site, git: GitDates): Date | undefined {
  const frontMatter = dateOfValue(page.frontMatter.last_modified_at);
  if (frontMatter !== undefined) return frontMatter;
  if (!git.available) return undefined;
  for (const candidate of sourceCandidates(page, site)) {
    if (!existsSync(resolve(git.root, candidate))) continue;
    const date = gitDateOf(git, candidate);
    if (date !== undefined) return date;
  }
  return undefined;
}

/** One page in the feed, already dated and absolutely addressed. */
interface Entry {
  readonly title: string;
  readonly url: string;
  readonly updated: Date;
  readonly summary?: string;
}

/** One `<entry>` block, indented like the feed. */
function entryXml(entry: Entry): string[] {
  return [
    "  <entry>",
    `    <title>${escapeXml(entry.title)}</title>`,
    `    <link href="${escapeXml(entry.url)}" rel="alternate" type="text/html"/>`,
    `    <id>${escapeXml(entry.url)}</id>`,
    `    <updated>${entry.updated.toISOString()}</updated>`,
    ...(entry.summary === undefined ? [] : [`    <summary>${escapeXml(entry.summary)}</summary>`]),
    "  </entry>",
  ];
}

/**
 * Writes `changes.xml`: an Atom 1.0 feed of the {@link LIMIT} most recently changed doc pages, newest first, so
 * people can follow changes to the docs.
 *
 * A page's date is `last_modified_at` in its front matter. Without one, and when `root` is inside a git work tree,
 * the committer date of the last commit that touched the page's source file is used; a page with no date is left
 * out. Entries are sorted newest first and, on the same date, by URL, so the same model and history give the same
 * bytes. Entry ids and links are absolute (the config's `url` plus the page's URL, which already carries `base`).
 *
 * A site without a valid `url` cannot have absolute links, and a site where no doc page has a date has nothing to
 * report: both write no file, with no error. Problems in the content are reported, never thrown.
 */
export async function changesFeed(site: Site, root: string = process.cwd()): Promise<readonly OutputFile[]> {
  const origin = originOf(site);
  if (origin === undefined) return [];

  const git = gitDatesAt(root);
  const entries: Entry[] = [];
  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    const updated = dateOfPage(page, site, git);
    if (updated === undefined) continue;
    const summary = typeof page.frontMatter.description === "string" ? page.frontMatter.description.trim() : "";
    entries.push({
      title: page.title,
      url: new URL(page.url, origin).href,
      updated,
      ...(summary === "" ? {} : { summary }),
    });
  }
  if (entries.length === 0) return [];

  entries.sort((a, b) => b.updated.getTime() - a.updated.getTime() || byCodePoint(a.url, b.url));
  const newest = entries.slice(0, LIMIT);

  const base = site.config.base.replace(/\/+$/, "");
  const self = `${origin}${base}/${FILE}`;
  const home = `${origin}${base}/`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(site.config.lang)}">`,
    `  <title>${escapeXml(site.config.title)}</title>`,
    `  <link href="${escapeXml(self)}" rel="self" type="application/atom+xml"/>`,
    `  <link href="${escapeXml(home)}" rel="alternate" type="text/html"/>`,
    `  <id>${escapeXml(self)}</id>`,
    `  <updated>${newest[0]!.updated.toISOString()}</updated>`,
    "  <author>",
    `    <name>${escapeXml(site.config.title)}</name>`,
    "  </author>",
    ...newest.flatMap(entryXml),
    "</feed>",
    "",
  ].join("\n");

  return [{ path: FILE, contents: xml }];
}

/** The `feed` output: the Atom feed of changed pages. */
export const feed: Output = {
  name: "feed",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    return changesFeed(site);
  },
};
