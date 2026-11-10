import type { NavGroup, NavItem, NavLink, Page, Site } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { isAppPage } from "./app-pages.ts";

/** The file this output writes at the output root. */
const FILE = "llms-full.txt";

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a navigation item that names a group of links rather than a link. */
function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

/** Collapses every run of whitespace to one space, so a title or summary never breaks a line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `url` is under `prefix`, observing path-segment boundaries (the same rule as `navState`). */
function under(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) return false;
  if (prefix.endsWith("/")) return true;
  const boundary = url.charAt(prefix.length);
  return boundary === "" || boundary === "/";
}

/** The body's text as the twin writes it: LF line endings, no blank first or last line. */
function bodyOf(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

/** The page header: its title, then the address an agent can fetch it from. */
function blockOf(page: Page, origin: string): string {
  const header = [`# ${oneLine(page.title)}`, "", `Source: ${origin}${page.url}`].join("\n");
  const body = bodyOf(page.markdown);
  return body === "" ? header : `${header}\n\n${body}`;
}

/** The list the reading order follows: the sidebar's list (`main`, else `docs`, else the first by name). */
function navList(site: Site): readonly NavItem[] {
  for (const name of ["main", "docs"]) {
    const items = site.nav[name];
    if (items !== undefined) return items;
  }
  const names = Object.keys(site.nav).sort(byCodePoint);
  return names.length > 0 ? (site.nav[names[0]!] ?? []) : [];
}

/**
 * Every doc page, in reading order: the navigation's leaves first, a section's `match` pages expanded where the
 * section sits, then the pages the navigation does not list, sorted by URL. App pages are left out, and so is a link
 * to an external address or to a page the model does not have.
 */
function readingOrder(site: Site): Page[] {
  const docs = new Map<string, Page>();
  for (const page of site.pages) {
    if (page.kind === "doc" && !isAppPage(page.url, { pages: site.pages })) docs.set(page.url, page);
  }

  const ordered: Page[] = [];
  const seen = new Set<string>();
  const add = (page: Page): void => {
    if (seen.has(page.url)) return;
    seen.add(page.url);
    ordered.push(page);
  };

  const expand = (link: NavLink): void => {
    const page = docs.get(link.url);
    if (page !== undefined) add(page);
    if (link.match === undefined) return;
    const section = [...docs.values()].sort((a, b) => byCodePoint(a.url, b.url));
    for (const candidate of section) {
      if (candidate.url !== link.url && under(candidate.url, link.match)) add(candidate);
    }
  };

  const visit = (items: readonly NavItem[]): void => {
    for (const item of items) {
      if (isGroup(item)) visit(item.children);
      else expand(item);
    }
  };
  visit(navList(site));

  for (const page of [...docs.values()].sort((a, b) => byCodePoint(a.url, b.url))) add(page);
  return ordered;
}

/**
 * Writes `llms-full.txt`: the site title and summary, then every doc page's Markdown source in reading order. Each page
 * starts with a header naming its title and URL, and pages are separated by `---`. Front matter is already gone from
 * `page.markdown`, and directives stay in their source form, so an agent reads the same text the Markdown twin holds.
 *
 * The URL is absolute when the config sets `url`, and site-relative (with `base`) otherwise. App pages appear nowhere,
 * because they are programs rather than documents. Two builds of the same site write the same bytes.
 */
export const llmsFull: Output = {
  name: "llms-full",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const origin = site.config.url?.replace(/\/+$/, "") ?? "";
    const lines: string[] = [`# ${oneLine(site.config.title)}`];
    const summary = site.config.description === undefined ? "" : oneLine(site.config.description);
    if (summary !== "") lines.push("", `> ${summary}`);

    for (const page of readingOrder(site)) {
      lines.push("", "---", "", blockOf(page, origin));
    }

    return [{ path: FILE, contents: `${lines.join("\n")}\n` }];
  },
};
