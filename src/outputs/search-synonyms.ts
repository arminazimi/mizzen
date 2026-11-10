import { stringify } from "yaml";
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The `_data` key that holds the synonyms, from `_data/search-synonyms.yml`. */
const DATA_KEY = "search-synonyms";

/** The configuration file Pagefind looks for in the folder it runs from. */
const FILE = "pagefind.yml";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The normalized synonyms: a term to the words treated as it, both sides sorted by code point and both without
 * duplicates, so the same input always gives the same file.
 */
export type Synonyms = ReadonlyMap<string, readonly string[]>;

/** Collects terms while the input is read; a term may appear in more than one list entry. */
type Pending = Map<string, Set<string>>;

/** Adds one term and its words; a string is one word and an array is several. Blank terms and words are dropped. */
function add(pending: Pending, term: unknown, words: unknown): void {
  if (typeof term !== "string" || term.trim() === "") return;
  const list = typeof words === "string" ? [words] : Array.isArray(words) ? words : undefined;
  if (list === undefined) return;

  const key = term.trim();
  const set = pending.get(key) ?? new Set<string>();
  for (const word of list) {
    if (typeof word !== "string") continue;
    const value = word.trim();
    if (value !== "" && value !== key) set.add(value);
  }
  pending.set(key, set);
}

/** Turns a pending map into the sorted, de-duplicated form, dropping terms left with no words. */
function finish(pending: Pending): Synonyms {
  const result = new Map<string, readonly string[]>();
  for (const term of [...pending.keys()].sort(byCodePoint)) {
    const words = [...(pending.get(term) ?? [])].sort(byCodePoint);
    if (words.length > 0) result.set(term, words);
  }
  return result;
}

/**
 * Reads the two documented shapes:
 *
 * - a mapping, `{ install: [setup, configure] }`, where a string value is one word;
 * - a list of entries, each a one-key (or many-key) mapping, a `{ term, synonyms }` mapping, or an array whose
 *   first item is the term and whose rest are its words; a list of plain strings is one group in that order.
 *
 * Returns `undefined` when the value is neither shape, so the caller can report it, and an empty map when it is a
 * valid shape with nothing in it.
 */
export function readSynonyms(raw: unknown): Synonyms | undefined {
  if (raw === undefined || raw === null) return new Map();

  const pending: Pending = new Map();
  if (Array.isArray(raw)) {
    if (raw.every((entry): entry is string => typeof entry === "string")) {
      const [term, ...words] = raw;
      add(pending, term, words);
      return finish(pending);
    }
    for (const entry of raw) {
      if (Array.isArray(entry)) {
        const [term, ...words] = entry;
        add(pending, term, words);
      } else if (isMapping(entry) && "synonyms" in entry) {
        add(pending, entry.term, entry.synonyms);
      } else if (isMapping(entry)) {
        for (const [term, words] of Object.entries(entry)) add(pending, term, words);
      } else {
        return undefined;
      }
    }
    return finish(pending);
  }

  if (isMapping(raw)) {
    for (const [term, words] of Object.entries(raw)) add(pending, term, words);
    return finish(pending);
  }

  return undefined;
}

/** The fallback: `theme.options.search.synonyms`, read as the same two shapes. */
function themeSynonyms(site: Site): unknown {
  const search = site.config.theme.options?.search;
  return isMapping(search) ? search.synonyms : undefined;
}

/**
 * The `pagefind.yml` text for a synonym map. Keys and values are sorted by code point and the
 * `yaml` package quotes anything that would otherwise change the meaning, so a term such as `cache: warm` or a
 * word with `#` survives a round trip.
 *
 * Pagefind 1.6 reads `pagefind.yml` but has no `synonyms` option in either the CLI configuration or the service API
 * (`createIndex`), and ignores keys it does not know. The block is therefore the handoff this output promises, not
 * something the in-process index in `search.ts` applies; the comment in the file says so. See the output's doc
 * comment and `changelog.d/1559.md`.
 */
export function synonymConfig(synonyms: Synonyms): string {
  const block: Record<string, readonly string[]> = {};
  for (const term of [...synonyms.keys()].sort(byCodePoint)) {
    block[term] = synonyms.get(term) ?? [];
  }

  const header = [
    "# Pagefind configuration written by Mizzen's `search-synonyms` output.",
    "# Each key is a search term; each value is a word or phrase that should match it.",
    "#",
    "# Pagefind 1.6 has no `synonyms` option and ignores keys it does not know, so",
    "# this block does not change the index it builds. It records the mapping for the",
    "# index tool, for a Pagefind version that reads it, and for tools that share this file.",
  ].join("\n");

  return `${header}\n${stringify({ synonyms: block }, { lineWidth: 0 })}`;
}

/**
 * Writes Pagefind's configuration file, `pagefind.yml`, with the site's search synonyms: `install` = `setup`, for
 * example. Pagefind reads a configuration file from the folder the indexing tool runs in, so the file lands at the
 * root of the output folder. Without synonyms no file is written.
 *
 * The synonyms come from `_data/search-synonyms.yml` (YAML or JSON, key `search-synonyms` in `site.data`), or from
 * `theme.options.search.synonyms` when the data file is absent, which keeps search settings next to the other theme
 * options without changing the frozen config schema. A value that is neither a map nor a list is a warning, not a
 * build failure.
 *
 * The Pagefind 1.6 service API (`createIndex`) has no synonym option, so this unit does not edit `search.ts` and the
 * in-process index is unchanged; the file is the only handoff. That gap is recorded in the module's YAML comment,
 * in `changelog.d/1559.md`, and in the pull request rather than claimed as working.
 */
export const searchSynonyms: Output = {
  name: "search-synonyms",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const raw = site.data[DATA_KEY] !== undefined ? site.data[DATA_KEY] : themeSynonyms(site);
    const synonyms = readSynonyms(raw);
    if (synonyms === undefined) {
      ctx.report({
        id: "search-synonyms.invalid",
        severity: "warning",
        message: "`search-synonyms` must be a map of term to words, or a list of such entries.",
        help: "Use `install: [setup, configure]` in `_data/search-synonyms.yml`, or set `theme.options.search.synonyms` to the same shape.",
      });
      return [];
    }
    if (synonyms.size === 0) return [];
    return [{ path: FILE, contents: synonymConfig(synonyms) }];
  },
};
