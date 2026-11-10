import type { Site } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { readingTimeForPages, type ReadingTimePage } from "../model/facts/reading-time.ts";

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads one stored entry, rejecting a site override that does not have the shape the output promises. */
function entryOf(value: unknown): ReadingTimePage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { url, words, minutes, source } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof words !== "number" || typeof minutes !== "number" || typeof source !== "string") {
    return undefined;
  }
  return { url, words, minutes, source };
}

/**
 * The entries to write: the `reading-time` fact or a site's `_data/reading-time.yml` when it has one, so the output
 * and the theme read the same numbers. A value that is not an array of entries is ignored and recomputed from the
 * pages, because the output still has to be deterministic and complete. Entries always come back sorted by URL with
 * the fixed key order `url`, `words`, `minutes`, `source`.
 */
function entriesOf(site: Site): readonly ReadingTimePage[] {
  const value = site.data["reading-time"];
  if (Array.isArray(value)) {
    const entries = value.map(entryOf);
    if (entries.every((entry): entry is ReadingTimePage => entry !== undefined)) {
      return entries.sort((a, b) => byCodePoint(a.url, b.url));
    }
  }
  return readingTimeForPages(site.pages);
}

/**
 * Writes `reading-time.json`: one entry per doc page with its URL, word count, reading time in whole minutes, and
 * source file, sorted by URL. The numbers are the `reading-time` fact's when the site did not override them, so the
 * file and a theme rendering the same page agree. Words follow `countWords`: code and HTML markup do not count,
 * Latin and Cyrillic use Unicode word boundaries, Persian and Arabic keep the zero-width non-joiner inside a word, and
 * each Han, Kana, and Hangul character is one word. Reading time is `ceil(words / 200)`; the rate is documented and
 * overridable through the module's options.
 *
 * App and asset pages are left out, since they are programs or files rather than prose. The site is free to override
 * the whole list in `_data/reading-time.yml` (ADR 0028). The file is one JSON array with a fixed key order and a
 * trailing line feed, so two runs on the same site write the same bytes.
 */
export const readingTime: Output = {
  name: "reading-time",
  async run(site: Site): Promise<readonly OutputFile[]> {
    return [{ path: "reading-time.json", contents: `${JSON.stringify(entriesOf(site), null, 2)}\n` }];
  },
};
