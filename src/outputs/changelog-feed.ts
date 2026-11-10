import { basename } from "node:path";
import type { Heading, Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The feed's file name, relative to the output folder. */
const FILE = "changelog.xml";

/** Compared by code point, never by locale (ADR 0022, rule 5). */
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
 * A date value as a date: the front matter schema allows a date, or a date and a time with an optional offset. A time
 * without an offset is UTC, so a build gives the same bytes in every time zone. A value that is not a real calendar
 * date reads as no date.
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

/** The first `YYYY-MM-DD` in a heading's text as a UTC midnight date; `undefined` when there is none or it is no real date. */
function dateOfHeading(text: string): Date | undefined {
  const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  return match === null ? undefined : dateOfValue(match[0]);
}

/** The changelog page: the first by URL with `changelog: true`, else the first whose source is `CHANGELOG.md`, else the page at `/changelog/`. */
function changelogPageOf(site: Site): Page | undefined {
  const docs = site.pages.filter((page) => page.kind === "doc");
  const flagged = docs.filter((page) => page.frontMatter.changelog === true);
  if (flagged.length > 0) return firstByUrl(flagged);

  const named = docs.filter((page) => basename(page.source.file) === "CHANGELOG.md");
  if (named.length > 0) return firstByUrl(named);

  const base = site.config.base.replace(/\/+$/, "");
  return docs.find((page) => page.url === "/changelog/" || page.url === `${base}/changelog/`);
}

/** The page with the lowest URL, so a site with several candidates always picks the same one. */
function firstByUrl(pages: readonly Page[]): Page | undefined {
  return [...pages].sort((a, b) => byCodePoint(a.url, b.url))[0];
}

/** An entry's date: a `YYYY-MM-DD` in the heading text, else `updated`, else `last_modified_at` from front matter. */
function dateOfEntry(page: Page, heading: Heading): Date | undefined {
  return (
    dateOfHeading(heading.text) ??
    dateOfValue(page.frontMatter.updated) ??
    dateOfValue(page.frontMatter.last_modified_at)
  );
}

/** One dated heading in the feed, already addressed. */
interface Entry {
  readonly title: string;
  readonly id: string;
  readonly link: string;
  readonly updated: Date;
  /** The heading's position in document order, the tie-break on the same date. */
  readonly order: number;
}

/** One `<entry>` block, indented like the feed. */
function entryXml(entry: Entry): string[] {
  return [
    "  <entry>",
    `    <title>${escapeXml(entry.title)}</title>`,
    `    <link href="${escapeXml(entry.link)}" rel="alternate" type="text/html"/>`,
    `    <id>${escapeXml(entry.id)}</id>`,
    `    <updated>${entry.updated.toISOString()}</updated>`,
    "  </entry>",
  ];
}

/** The absolute form of a page URL when the site has a `url`, else the URL as the model gives it. */
function addressOf(url: string, origin: string | undefined): string {
  return origin === undefined ? url : new URL(url, origin).href;
}

/**
 * Writes `changelog.xml`: an Atom 1.0 feed with one entry per release heading of the changelog page.
 *
 * The changelog page is the first doc page, by URL, with `changelog: true` in its front matter; without one, the first
 * doc page whose source is named `CHANGELOG.md`; without one, the doc page at `/changelog/`. Its entries are the page's
 * `h2` headings, or its `h3` headings when it has no `h2`. An entry's date is the first `YYYY-MM-DD` in the heading
 * text, else `updated`, else `last_modified_at` from the page's front matter; a heading with no date is left out,
 * because Atom requires one. Entries are newest first and, on the same date, in document order, so the same model gives
 * the same bytes.
 *
 * Entry ids and links are absolute when the config has a `url` and relative otherwise (the page URL plus the heading's
 * anchor). A site with no changelog page, or whose changelog headings all lack a date, writes no file, with no error.
 */
export async function changelogFeed(site: Site): Promise<readonly OutputFile[]> {
  const page = changelogPageOf(site);
  if (page === undefined) return [];

  const level = page.headings.some((heading) => heading.depth === 2) ? 2 : 3;
  const origin = originOf(site);
  const address = addressOf(page.url, origin);

  const entries: Entry[] = [];
  for (const [order, heading] of page.headings.entries()) {
    if (heading.depth !== level) continue;
    const updated = dateOfEntry(page, heading);
    if (updated === undefined) continue;
    const anchor = `${address}#${heading.id}`;
    entries.push({ title: heading.text, id: anchor, link: anchor, updated, order });
  }
  if (entries.length === 0) return [];

  entries.sort((a, b) => b.updated.getTime() - a.updated.getTime() || a.order - b.order);

  const base = site.config.base.replace(/\/+$/, "");
  const self = addressOf(`${base}/${FILE}`, origin);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(site.config.lang)}">`,
    `  <title>${escapeXml(site.config.title)}</title>`,
    `  <link href="${escapeXml(self)}" rel="self" type="application/atom+xml"/>`,
    `  <link href="${escapeXml(address)}" rel="alternate" type="text/html"/>`,
    `  <id>${escapeXml(self)}</id>`,
    `  <updated>${entries[0]!.updated.toISOString()}</updated>`,
    "  <author>",
    `    <name>${escapeXml(site.config.title)}</name>`,
    "  </author>",
    ...entries.flatMap(entryXml),
    "</feed>",
    "",
  ].join("\n");

  return [{ path: FILE, contents: xml }];
}

/** The `changelog-feed` output: the Atom feed of changelog entries. */
export const changelogFeedOutput: Output = {
  name: "changelog-feed",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    return changelogFeed(site);
  },
};
