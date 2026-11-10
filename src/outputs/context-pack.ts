import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { rankPages } from "../packs/rank.ts";
import { estimateTokens } from "../packs/tokens.ts";
import { trimPages } from "../packs/trim.ts";

/**
 * Writes one ready-to-paste context pack per configured topic: `pack/<topic>.md`.
 *
 * A pack is a Markdown file an agent can paste into a prompt without reading the site. Topics come from
 * `_data/context-packs.yml` (also readable as `_data/contextPacks.yml`), as a list of entries:
 *
 * ```yaml
 * - topic: Install
 *   query: install the engine   # optional; defaults to `topic`
 *   budget: 6000                # optional; estimated tokens, defaults to 6000
 *   pages: [/guide/install/, guide/setup.md]  # optional; restricts the candidates
 * ```
 *
 * For each topic the output ranks doc pages with {@link rankPages}, using `query` or the topic name. Pages
 * that match no query term are left out, unless `pages` names them explicitly. The candidates are then
 * trimmed with {@link trimPages} to the budget, dropping whole sections from the least relevant page first,
 * so the pack always fits the budget unless a page's mandatory lead (its heading and first paragraph) does
 * not. When that happens the lead is kept, the pack is larger than the budget, and the warning
 * `pack.trim.over-budget` reports the page and its source position.
 *
 * Every page section is:
 *
 * ```markdown
 * ## Page title
 *
 * - URL: /guide/install/ (absolute when the site config has `url`)
 * - Source: `guide/install.md`
 *
 * The trimmed Markdown.
 * ```
 *
 * A leading `# Title` line in a page's Markdown is dropped, because the section header already names the
 * page. The budget counts the pack title, the section headers, and the trimmed Markdown, estimated with
 * {@link estimateTokens}. Slugs are ASCII: the topic is lower-cased, every run outside `[a-z0-9]` becomes
 * one `-`, leading and trailing `-` are removed, and two topics with the same slug get `-2`, `-3`, and so
 * on in input order. A topic with no slug left (a name written only in a non-Latin script, for example)
 * falls back to `topic-<position>`.
 *
 * Files are sorted by path, the input order never reaches the bytes otherwise, and the output reads no
 * clock, network, environment, or disk: the same model gives the same files.
 */

/** The `_data` key `_data/contextPacks.yml` loads under. */
const DATA_KEY = "contextPacks";

/** The `_data` key `_data/context-packs.yml` loads under. */
const KEBAB_DATA_KEY = "context-packs";

/** The token budget a topic gets when it names none. */
export const DEFAULT_BUDGET = 6000;

/** One topic after its value has been read and validated. The CLI's `pack` command reads the same shape. */
export interface PackTopic {
  /** The display name, collapsed to one line. */
  readonly topic: string;
  /** The trimmed token budget of the whole pack. */
  readonly budget: number;
  /** The ranking query; defaults to the topic. */
  readonly query: string;
  /** `undefined` when every doc page is a candidate; otherwise the page URLs or source paths named. */
  readonly pages: readonly string[] | undefined;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapses every run of whitespace to one space, so a value never breaks a line of the pack. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A page's source path with forward slashes, as the pack shows it. */
function sourceOf(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/**
 * The URL the pack shows for a page: absolute when the config has `url`, else the site-relative URL the
 * model carries (which includes `base`).
 */
function urlOf(page: Page, site: Site): string {
  const origin = site.config.url?.replace(/\/+$/, "");
  return origin === undefined || origin === "" ? page.url : `${origin}${page.url}`;
}

/** The header of one page section, without the body. */
function headerOf(page: Page, site: Site): string {
  return `## ${oneLine(page.title)}\n\n- URL: ${urlOf(page, site)}\n- Source: \`${sourceOf(page)}\``;
}

/** The pack's title line. */
function titleOf(topic: string): string {
  return `# Context pack: ${topic}`;
}

/** One page section while the pack is assembled. */
interface Section {
  readonly header: string;
  readonly body: string;
}

/** Assembles a pack: the title first, then one section per page, with one blank line between parts. */
function assemble(topic: string, sections: readonly Section[]): string {
  const parts = [titleOf(topic)];
  for (const section of sections) {
    parts.push(section.body === "" ? section.header : `${section.header}\n\n${section.body}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * Drops a leading ATX level-one heading and the blank lines after it. The pack's section header names the
 * page already, so keeping the page's own `# Title` would duplicate it and break the heading outline.
 */
function withoutLeadHeading(markdown: string): string {
  return markdown.replace(/^#[ \t]+[^\n]*(?:\n+|$)/, "").replace(/^\n+/, "");
}

/** The slug a topic's file is named after: lower-case ASCII letters, digits, and single hyphens. */
export function slugOf(topic: string): string {
  return topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A slug that no earlier topic took, adding `-2`, `-3`, and so on in input order. */
function uniqueSlug(base: string, used: Set<string>, position: number): string {
  const start = base === "" ? `topic-${position}` : base;
  let candidate = start;
  for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${start}-${suffix}`;
  used.add(candidate);
  return candidate;
}

/** A page's URL without the site `base`, for matching `pages` entries written as site paths. */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** Whether a `pages` entry names a page, by URL (with or without `base` and a trailing slash) or source path. */
function matchesReference(page: Page, reference: string, base: string): boolean {
  const value = reference.trim().replace(/\\/g, "/");
  if (value === "") return false;

  const url = value.startsWith("/") ? value : `/${value}`;
  const candidate = url.length > 1 ? url.replace(/\/+$/, "") : url;
  for (const pageUrl of [page.url, underBase(page.url, base)]) {
    const comparable = pageUrl.length > 1 ? pageUrl.replace(/\/+$/, "") : pageUrl;
    if (comparable === candidate) return true;
  }

  const source = value.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "");
  return source !== "" && sourceOf(page) === source;
}

/** Reads `topic`, `budget`, `query`, and `pages` from one entry, reporting what it cannot use. */
export function readPackTopic(entry: unknown, position: number, ctx: OutputContext): PackTopic | undefined {
  if (!isMapping(entry)) {
    ctx.report({
      id: "context-pack.invalid-topic",
      severity: "warning",
      message: `Context pack entry ${position} is not a mapping with a \`topic\`.`,
      help: "Write `- topic: Install` or `- { topic: Install, budget: 6000 }` in `_data/context-packs.yml`.",
    });
    return undefined;
  }

  const topic = typeof entry.topic === "string" ? oneLine(entry.topic) : "";
  if (topic === "") {
    ctx.report({
      id: "context-pack.invalid-topic",
      severity: "warning",
      message: `Context pack entry ${position} has no topic name.`,
      help: "Give every entry a non-empty `topic`.",
    });
    return undefined;
  }

  let budget = DEFAULT_BUDGET;
  if (entry.budget !== undefined) {
    if (typeof entry.budget === "number" && Number.isFinite(entry.budget) && entry.budget >= 1) {
      budget = Math.floor(entry.budget);
    } else {
      ctx.report({
        id: "context-pack.invalid-budget",
        severity: "warning",
        message: `Context pack "${topic}" has a budget that is not a positive number; ${DEFAULT_BUDGET} tokens are used.`,
        help: "Set `budget` to a positive integer number of estimated tokens.",
      });
    }
  }

  const query = typeof entry.query === "string" && oneLine(entry.query) !== "" ? oneLine(entry.query) : topic;

  let pages: readonly string[] | undefined;
  if (entry.pages !== undefined) {
    if (Array.isArray(entry.pages) && entry.pages.every((value) => typeof value === "string")) {
      pages = entry.pages.map((value: string) => value.trim()).filter((value) => value !== "");
    } else {
      ctx.report({
        id: "context-pack.invalid-pages",
        severity: "warning",
        message: `Context pack "${topic}" has a \`pages\` value that is not a list of strings; every page is a candidate.`,
        help: "List page URLs or source paths, such as `/guide/install/` or `guide/install.md`.",
      });
    }
  }

  return { topic, budget, query, pages };
}

/** The topic list from `site.data`, or `undefined` when the key is absent or unusable. */
export function readPackTopics(site: Site, ctx: OutputContext): readonly unknown[] | undefined {
  const raw = site.data[DATA_KEY] !== undefined ? site.data[DATA_KEY] : site.data[KEBAB_DATA_KEY];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    ctx.report({
      id: "context-pack.invalid-data",
      severity: "warning",
      message: "`context-packs` must be a list of topics.",
      help: "Write `- topic: Install` entries in `_data/context-packs.yml`.",
    });
    return undefined;
  }
  return raw;
}

/** The candidates for a topic, in ranking order. */
function candidatesOf(site: Site, topic: PackTopic): readonly Page[] {
  const docs = site.pages.filter((page) => page.kind === "doc");
  const ranked = rankPages(docs, topic.query, { base: site.config.base });
  const named = topic.pages;
  if (named === undefined) {
    return ranked.filter((entry) => entry.score > 0).map((entry) => entry.page);
  }
  return ranked
    .filter((entry) => named.some((reference) => matchesReference(entry.page, reference, site.config.base)))
    .map((entry) => entry.page);
}

/** The tokens of the mandatory content of every candidate, measured by trimming each page to zero. */
async function mandatoryTokensOf(pages: readonly Page[]): Promise<ReadonlyMap<string, number>> {
  const probe = await trimPages(pages, 0);
  const costs = new Map<string, number>();
  for (const page of probe.pages) costs.set(page.url, page.tokens);
  return costs;
}

/** A topic with no pages is reported, not written. */
function noPagesDiagnostic(topic: PackTopic): Diagnostic {
  return {
    id: "context-pack.no-pages",
    severity: "warning",
    message:
      topic.pages === undefined
        ? `Context pack "${topic.topic}" has no pages: no page matches the query "${topic.query}".`
        : `Context pack "${topic.topic}" names pages that the site does not have or that do not match the query "${topic.query}".`,
    help: "Add a page that covers the topic, change `query`, or name `pages` with existing page URLs or source paths.",
  };
}

/** One topic's finished pack. */
export interface PackContents {
  /** The topic's file name, without `.md`. */
  readonly slug: string;
  /** The pack's Markdown. */
  readonly contents: string;
}

/** Builds one pack, or `undefined` when the topic has no pages. */
export async function buildPack(site: Site, topic: PackTopic, ctx: OutputContext): Promise<PackContents | undefined> {
  const candidates = candidatesOf(site, topic);
  if (candidates.length === 0) {
    ctx.report(noPagesDiagnostic(topic));
    return undefined;
  }

  const mandatory = await mandatoryTokensOf(candidates);

  // Select pages in ranking order while their headers and mandatory content fit. The first page is always
  // kept, so a topic whose best page alone exceeds the budget still produces a pack and a warning.
  const selected: Page[] = [];
  let mandatorySum = 0;
  for (const page of candidates) {
    const next = [...selected, page];
    const overhead = estimateTokens(
      assemble(
        topic.topic,
        next.map((candidate) => ({ header: headerOf(candidate, site), body: "" })),
      ),
    ).tokens;
    const cost = mandatory.get(page.url) ?? 0;
    if (selected.length === 0 || overhead + mandatorySum + cost <= topic.budget) {
      selected.push(page);
      mandatorySum += cost;
    }
  }

  let chosen = selected;
  let diagnostics: readonly Diagnostic[] = [];
  let contents = "";
  for (;;) {
    const overhead = estimateTokens(
      assemble(
        topic.topic,
        chosen.map((page) => ({ header: headerOf(page, site), body: "" })),
      ),
    ).tokens;
    const trimmed = await trimPages(chosen, Math.max(0, topic.budget - overhead));
    const sections = chosen.map((page, index) => ({
      header: headerOf(page, site),
      body: withoutLeadHeading(trimmed.pages[index]?.markdown ?? page.markdown),
    }));
    contents = assemble(topic.topic, sections);
    const total = estimateTokens(contents).tokens;
    if (total <= topic.budget || chosen.length <= 1) {
      diagnostics = trimmed.diagnostics;
      if (total > topic.budget && diagnostics.length === 0) {
        ctx.report({
          id: "context-pack.over-budget",
          severity: "warning",
          message: `Context pack "${topic.topic}" is ${total} tokens, above its budget of ${topic.budget}; its mandatory lead is kept.`,
          pos: chosen[0]!.source,
          help: "Raise `budget`, shorten the page's lead, or rank a different page.",
        });
      }
      break;
    }
    chosen = chosen.slice(0, -1);
  }

  for (const diagnostic of diagnostics) ctx.report(diagnostic);

  return { slug: slugOf(topic.topic), contents };
}

/**
 * Writes `pack/<topic>.md` for every topic in `_data/context-packs.yml`. No topics means no files.
 *
 * The file name is the sanitized topic slug (see the rule at the top of this module), files are sorted by
 * path, and a topic with no candidate page is reported with `context-pack.no-pages` instead of writing an
 * empty pack. A malformed data file or topic entry is a warning, not a build failure, and produces no file
 * for that entry.
 */
export const contextPack: Output = {
  name: "context-pack",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const raw = readPackTopics(site, ctx);
    if (raw === undefined) return [];

    const used = new Set<string>();
    const files: OutputFile[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const topic = readPackTopic(raw[index], index + 1, ctx);
      if (topic === undefined) continue;
      const pack = await buildPack(site, topic, ctx);
      if (pack === undefined) continue;
      const slug = uniqueSlug(pack.slug, used, index + 1);
      files.push({ path: `pack/${slug}.md`, contents: pack.contents });
    }

    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
