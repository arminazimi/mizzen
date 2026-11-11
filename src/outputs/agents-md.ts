import { stringify } from "yaml";
import { CONFIG_FILE } from "../config/load.ts";
import { parseAgentInstructions } from "../content/agent-instructions.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The file this output writes at the output root. */
const FILE = "AGENTS.md";

/** A configured folder as a `/`-separated path with no leading `./` or trailing `/`; `""` for the root. */
function folderOf(folder: string | undefined): string {
  const path = (folder ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return path === "." ? "" : path;
}

/** The `source` config key as a folder under the site root, `/`-separated with no leading `./` or trailing `/`; `""` for the root. */
function sourceFolder(source: string): string {
  return folderOf(source);
}

/**
 * True when the site owns an `AGENTS.md` of its own. The site's file is a page of the model: a Markdown file at the
 * root of `source`, under the repository folder (its `source.file` names the file relative to the repository root),
 * or any page whose URL is the `AGENTS.md` at the site root (set with `permalink`). The model keeps unpublished pages
 * out, so such a file is not seen here; the generated file then stands in for it.
 */
function ownsAgentsMd(site: Site): boolean {
  const folder = [folderOf(site.config.repository?.dir), sourceFolder(site.config.source)]
    .filter((part) => part !== "")
    .join("/");
  const file = folder === "" ? FILE : `${folder}/${FILE}`;
  const url = `${site.config.base}/${FILE}`;
  return site.pages.some((page) => page.source.file === file || page.url === url);
}

/** The text of a list, or `none` when it is empty. */
function listOf(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.join(", ") : empty;
}

/** A URL under `base`, such as `/evergreen/guide/install/`. */
function urlOf(base: string, path: string): string {
  return `${base}${path}`;
}

/** One page's rule, as the `Page rules` section lists it. */
interface PageRule {
  readonly url: string;
  readonly rule: string;
}

/**
 * A rule on one line: a backslash is escaped first, then the control characters a YAML block scalar may hold, so a
 * rule never breaks the list item it sits in.
 */
function oneLine(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/**
 * The rules of a page's `agent` block, read with the agent-instructions parser. The model keeps the block as parsed
 * data, not as raw YAML, so the block is written back out for the parser; a problem it reports points at the page's
 * file, because the model no longer knows which line of the source held the block.
 */
function rulesOf(page: Page, ctx: OutputContext): readonly string[] {
  const agent = page.frontMatter.agent;
  if (agent === undefined || agent === null) return [];
  const parsed = parseAgentInstructions(stringify({ agent }), page.source.file);
  for (const diagnostic of parsed.diagnostics) {
    ctx.report({
      ...diagnostic,
      pos: { file: page.source.file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    });
  }
  return parsed.agent.rules ?? [];
}

/**
 * The `Page rules` section: one `- <page URL> — <rule>` line per pair, sorted by URL and then by rule, with a pair
 * listed once. Empty when no page has a rule, so a site without page rules writes exactly the file it wrote before.
 */
function pageRulesSection(pages: readonly Page[], ctx: OutputContext): string[] {
  const pairs: PageRule[] = [];
  for (const page of pages) {
    for (const rule of rulesOf(page, ctx)) pairs.push({ url: page.url, rule });
  }
  pairs.sort((a, b) => byCodePoint(a.url, b.url) || byCodePoint(a.rule, b.rule));

  const lines: string[] = [];
  for (const pair of pairs) {
    const line = `- ${oneLine(pair.url)} — ${oneLine(pair.rule)}`;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  if (lines.length === 0) return [];
  return [
    `## Page rules`,
    ``,
    `Rules the authors wrote for particular pages, from each page's \`agent.rules\`:`,
    ``,
    ...lines,
    ``,
  ];
}

/** The lines of the file, built from the config and the model; no theme or layout is named. */
function render(site: Site, ctx: OutputContext): string {
  const { config } = site;
  const base = config.base;
  const folder = sourceFolder(config.source);
  const sourceText = folder === "" ? "the site root" : `\`${folder}/\` under the site root`;
  const docs = site.pages.filter((page: Page) => page.kind === "doc");
  const apps = site.pages.filter((page: Page) => page.kind === "app");
  const pageRules = pageRulesSection(site.pages, ctx);
  const navLists = Object.keys(site.nav).sort(byCodePoint).map((name) => `\`${name}\``);
  const dataFiles = Object.keys(site.data).sort(byCodePoint).map((name) => `\`${name}\``);
  const languages =
    config.languages.length === 0
      ? ["- Languages: only the default language"]
      : [
          "- Languages, in switcher order:",
          ...config.languages.map((lang) =>
            lang.prefix === ""
              ? `  - ${lang.name} (\`${lang.code}\`): the default language, no URL prefix`
              : `  - ${lang.name} (\`${lang.code}\`): URL prefix \`${lang.prefix}\``,
          ),
        ];
  const folderPrefix = folder === "" ? "" : `${folder}/`;
  const example = urlOf(base, "/guide/new-page/");
  const repo = config.repository;

  const lines: string[] = [
    `# AGENTS.md`,
    ``,
    `Instructions for coding agents that work on the site **${config.title}**. This file is written by the build from the site's config and content, so it describes this build. Read it before every task.`,
    ``,
    `## Site`,
    ``,
    `- Title: ${config.title}`,
    `- Description: ${config.description ?? "none"}`,
    `- URL: ${config.url ?? "not set; canonical links and the sitemap are left out"}`,
    `- Base path: ${base === "" ? "none, the site is at the domain root" : `\`${base}\``}`,
    `- Default language: \`${config.lang}\`, direction \`${config.dir}\``,
    ...languages,
    ``,
    `## Where content lives`,
    ``,
    `- Config: \`${CONFIG_FILE}\` at the site root. Every path in it is relative to the site root.`,
    `- Source folder: ${sourceText}.`,
    `- Navigation: \`${config.navigation}\`. Navigation lists in this build: ${listOf(navLists, "none; the docs list is built from the folders")}.`,
    `- Data files (\`_data/\`): ${listOf(dataFiles, "none")}.`,
    `- Edit links: ${repo ? `${repo.url}, branch \`${repo.branch ?? "main"}\`, folder ${repo.dir ? `\`${repo.dir}\`` : "the repository root"}` : "none; no repository is set"}.`,
    `- Pages in this build: ${docs.length} rendered from Markdown or HTML, and ${apps.length} app ${apps.length === 1 ? "page" : "pages"} copied as they are.`,
    ``,
    `## Pages`,
    ``,
    `- Each Markdown file (\`.md\`, \`.markdown\`) under the source folder is a page. An HTML file is a page only when it starts with front matter.`,
    `- A page's URL follows its path: \`${folderPrefix}guide/install.md\` is served at \`${urlOf(base, "/guide/install/")}\`. \`index.md\` and \`README.md\` are served at their folder's URL.`,
    `- Front matter \`permalink\` sets another URL. A URL that names a file, such as \`/404.html\`, is written as that file.`,
    `- Folders whose name starts with \`_\` are skipped, except \`_data\`. Names that start with \`.\` are skipped.`,
    `- A folder whose \`index.html\` has no front matter is an app page: every file in it is copied as it is.`,
    `- Front matter keys the engine reads: \`title\`, \`description\`, \`permalink\`, \`redirect_from\`, \`redirect_to\`, \`lang\`, \`dir\`, \`order\`, \`status\`, \`agent\`, \`search\`, \`published\`, \`image\`, and \`translation_key\`. Other keys are kept for rendering.`,
    `- A folder named after a language's URL prefix (for example \`fa/\` for the prefix \`/fa\`) holds that language's pages.`,
    ``,
    ...pageRules,
    `## How to add a page`,
    ``,
    `1. Create \`${folderPrefix}<folder>/<page>.md\`. The file name sets the page's address.`,
    `2. Start the file with front matter and write plain Markdown after it:`,
    ``,
    "```markdown",
    `---`,
    `title: New page`,
    `description: One sentence about the page.`,
    `---`,
    ``,
    `Plain Markdown here.`,
    "```",
    ``,
    `3. To list the page in navigation, add an item with \`title\` and \`url\` to the \`docs\` list (the sidebar) or the \`main\` list (the header) in \`${config.navigation}\`. \`url\` is the page's address, such as \`${example}\`. If that file has no lists, the sidebar is built from the folders instead, ordered by \`order\` and then by title.`,
    `4. Build the site and check the change (see below).`,
    ``,
    `## How to check a change`,
    ``,
    `1. Build the site.`,
    `2. Check the site: \`npx mizzen doctor\`.`,
    `3. Read every finding. Each one names a file and often a line. Fix it in the source, build again, and repeat until the check is clean.`,
    ``,
    `## Generated files`,
    ``,
    `- Everything the build writes to the build folder is generated: a rendered \`index.html\` for each page, the copied files, and this \`${FILE}\`. Edit the source, never the build folder.`,
    `- An output can be turned off in the config's \`outputs\` map by its name. \`outputs:\` with \`agents-md: false\` removes only this file.`,
    ``,
    `## Never`,
    ``,
    `- Never edit the build folder; the next build replaces it.`,
    `- Never invent front matter keys or config keys; use only the ones listed here or in the schema of the config.`,
    `- Never change \`translation_key\` on one translation only; change every page that shares it, or none.`,
    `- Never rename a page's file to change its title; set \`title\`, because the file name is the page's address.`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * Writes `AGENTS.md` at the output root: how to edit the site, where its content lives, how to add a page, how to check
 * a change, and which files the build generates. A page's `agent.rules` become one `Page rules` section. Every line
 * comes from the config and the model, so two builds of the same site write the same file.
 *
 * A site's own `AGENTS.md` in its source wins: when the model has that page, this output writes nothing.
 */
export const agentsMd: Output = {
  name: "agents-md",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (ownsAgentsMd(site)) return [];
    return [{ path: FILE, contents: render(site, ctx) }];
  },
};
