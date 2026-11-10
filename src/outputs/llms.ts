import type { NavGroup, NavItem, NavLink, Page, Site } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { isAppPage } from "./app-pages.ts";

/** The section that collects links placed directly in a navigation list, outside any group. */
const PAGES_SECTION = "Pages";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapses every run of whitespace to one space, so a value never breaks a line of `llms.txt`. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Escapes the characters that would end a link's text early. */
function linkText(text: string): string {
  return oneLine(text).replace(/[\\[\]]/g, "\\$&");
}

/**
 * The Markdown twin of a page URL: the same address with `.md` in place of the HTML file, so a pretty URL
 * (`/guide/install/`) gives `/guide/install/index.md`, the site root gives `/index.md`, and `/404.html` gives `/404.md`.
 * Mirrors the file the HTML output writes. Returns undefined for a URL that names a file other than HTML, which has
 * no twin.
 */
function twinUrl(url: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".md")}`;
  if (last.includes(".")) return undefined;
  return `${url.endsWith("/") ? url : `${url}/`}index.md`;
}

/** True for a navigation item that is a group of links rather than a link. */
function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

/** One entry of a section: the twin's address and the page's description. */
interface Entry {
  readonly title: string;
  readonly href: string;
  readonly note?: string;
}

/**
 * Writes `llms.txt` (llmstxt.org): the site title as the top heading, the site description as the summary, and one
 * section per navigation group, each a list of links to the Markdown twins of its pages. Links placed directly in a
 * navigation list go to a `Pages` section. Navigation lists are read in the order the file names them, and a page
 * listed twice is listed once, under its first place.
 *
 * Only pages the model lists as documents are linked: an external link, a link to a missing page, and an app page
 * are left out, since none of them has a twin. A link is `- [title](url): description`, where the description is the
 * page's front matter `description`, when it has one. Absolute links use the site `url` when the site sets one, and
 * site-relative links (which include `base`) otherwise.
 */
export const llms: Output = {
  name: "llms",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const pages = new Map<string, Page>(site.pages.map((p) => [p.url, p]));
    const options = { pages: site.pages };
    const sections = new Map<string, Entry[]>();
    const listed = new Set<string>();

    const add = (section: string, link: NavLink): void => {
      if (listed.has(link.url)) return;
      const page = pages.get(link.url);
      if (page === undefined || page.kind !== "doc" || isAppPage(link.url, options)) return;
      const href = twinUrl(link.url);
      if (href === undefined) return;
      listed.add(link.url);
      const description = page.frontMatter.description;
      const note = typeof description === "string" && oneLine(description) !== "" ? oneLine(description) : undefined;
      const entries = sections.get(section) ?? [];
      entries.push({ title: linkText(link.title), href, ...(note === undefined ? {} : { note }) });
      sections.set(section, entries);
    };

    // A link takes the section of the group it sits in; a group nested in a group becomes a section of its own.
    const visit = (items: readonly NavItem[], section: string): void => {
      for (const item of items) {
        if (isGroup(item)) visit(item.children, oneLine(item.title));
        else add(section, item);
      }
    };
    for (const name of Object.keys(site.nav)) visit(site.nav[name] ?? [], PAGES_SECTION);

    const origin = site.config.url?.replace(/\/+$/, "") ?? "";
    const lines: string[] = [`# ${oneLine(site.config.title)}`, ""];
    const summary = site.config.description === undefined ? "" : oneLine(site.config.description);
    if (summary !== "") lines.push(`> ${summary}`, "");

    for (const [section, entries] of sections) {
      lines.push(`## ${section}`, "");
      for (const entry of entries) {
        const note = entry.note === undefined ? "" : `: ${entry.note}`;
        lines.push(`- [${entry.title}](${origin}${entry.href})${note}`);
      }
      lines.push("");
    }

    return [{ path: "llms.txt", contents: lines.join("\n") }];
  },
};
