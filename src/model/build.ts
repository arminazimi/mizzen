import { readFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import type { Heading as MdHeading, Root } from "mdast";
import { loadConfig } from "../config/load.ts";
import { loadData } from "../content/data.ts";
import { discover, type DiscoveredFile } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { expandIncludes } from "../content/includes.ts";
import { pageLang } from "../content/lang.ts";
import { permalink } from "../content/permalink.ts";
import { resolveTitle } from "../content/title.ts";
import type { Diagnostic, FrontMatter, Heading, NavTree, Page, Site, SourcePos } from "../contracts/index.ts";
import { markdownToHtml } from "../markdown/to-html.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { navFromFolders, type FolderPage } from "../nav/from-folders.ts";
import { loadNavigation } from "../nav/from-yaml.ts";
import { createDiagnostics, sortDiagnostics } from "../pipeline/diagnostics.ts";
import { pageCache, parseMarkdownWithCache, type PageCache } from "../pipeline/page-cache.ts";
import { applyFacts } from "./facts.ts";

/** What {@link buildModel} returns: the site and every finding made while assembling it. */
export interface ModelResult {
  /** The site model; always complete, even when `diagnostics` holds errors. */
  readonly site: Site;
  /** Findings from the config, discovery, front matter, Markdown, navigation, data, facts, and duplicate URLs, sorted. */
  readonly diagnostics: readonly Diagnostic[];
  /** Markdown pages parsed on this run; pages read from the page cache are not counted. */
  readonly parsedPages: number;
}

/** Options of {@link buildModel}. */
export interface BuildModelOptions {
  /**
   * Folder of the per-page Markdown cache. When set, each page's parsed tree is read from and written to it, so an
   * unchanged page is not parsed again. Front matter, includes, and every later stage still run every build.
   */
  readonly pageCacheDir?: string;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Applies `defaults` to a page's front matter: later entries win over earlier ones, and the page always wins. */
function withDefaults(
  data: Readonly<Record<string, unknown>>,
  path: string,
  defaults: readonly { readonly path: string; readonly values: Readonly<Record<string, unknown>> }[],
): FrontMatter {
  let merged: Record<string, unknown> = {};
  for (const entry of defaults) {
    const folder = entry.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (folder === "" || path === folder || path.startsWith(`${folder}/`)) merged = { ...merged, ...entry.values };
  }
  return { ...merged, ...data } as FrontMatter;
}

/** The site root's folder inside the repository, `/`-separated with no leading `./` or trailing `/`; `""` at the repository root. */
function repositoryFolder(dir: string | undefined): string {
  const folder = (dir ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return folder === "." ? "" : folder;
}

/** The file position, relative to the repository root, a path under `source` has. */
function posOf(file: string, line: number, endLine = line): SourcePos {
  return { file, line, column: 1, endLine, endColumn: 1 };
}

/** Headings with their positions, taken from the top-level `h` nodes in document order. */
function headingsOf(
  tree: { readonly children: readonly { readonly type: string }[] },
  collected: readonly { readonly depth: number; readonly text: string; readonly id: string }[],
  file: string,
): Heading[] {
  const nodes = tree.children.filter((n): n is MdHeading => n.type === "heading");
  return collected.map((h, i) => {
    const start = nodes[i]?.position?.start;
    const end = nodes[i]?.position?.end;
    const line = start?.line ?? 1;
    const column = start?.column ?? 1;
    const endLine = end?.line ?? line;
    const endColumn =
      endLine === line ? Math.max(column, (end?.column ?? column) - 1) : Math.max(1, (end?.column ?? 1) - 1);
    return {
      depth: h.depth as Heading["depth"],
      id: h.id,
      text: h.text,
      pos: { file, line, column, endLine, endColumn },
    };
  });
}

/** The page URL a folder of app files shares: `dashboard/index.html` is `/dashboard/`. */
function appUrl(folder: string, base: string): string {
  return permalink(`${folder}/index.html`, { base });
}

/**
 * Assembles the site model for the site at `root`: loads the config, discovers the files, and takes each page through
 * front matter, Markdown, title, permalink, and language. Pages are sorted by URL; two pages with one URL are an error
 * that names both sources. Navigation comes from the navigation file, or from the folders when the file is missing.
 *
 * With `options.pageCacheDir`, the Markdown parse of each page is cached by its expanded body, so a page whose body and
 * plugins are unchanged is not parsed again. Every other stage runs in full, so the model is the same either way.
 */
export async function buildModel(root: string, options: BuildModelOptions = {}): Promise<ModelResult> {
  const siteRoot = resolve(root);
  const diagnostics = createDiagnostics();
  const cache: PageCache | undefined =
    options.pageCacheDir === undefined ? undefined : pageCache(options.pageCacheDir);
  let parsedPages = 0;

  const loaded = loadConfig(siteRoot);
  for (const d of loaded.diagnostics) diagnostics.report(d);
  const config = loaded.config;
  const sourceDir = resolve(siteRoot, config.source);
  // Positions are relative to the repository root, so a site in `docs/` names `docs/…` paths. Without a repository
  // folder they stay relative to the site root, which is always stable wherever the site is checked out.
  const sourcePrefix = [repositoryFolder(config.repository?.dir), relative(siteRoot, sourceDir).split("\\").join("/")]
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  const fileOf = (path: string): string => (sourcePrefix === "" ? path : posix.join(sourcePrefix, path));

  const files: DiscoveredFile[] = await discover(sourceDir, { include: config.include, exclude: config.exclude });

  const pages: Page[] = [];
  const folderPages: FolderPage[] = [];
  const seen = new Map<string, SourcePos>();
  const appRoots = new Set<string>();

  const add = (page: Page, path: string, order: unknown): void => {
    const first = seen.get(page.url);
    if (first !== undefined) {
      diagnostics.error(
        "page.duplicate-url",
        `Two pages have the URL ${page.url}: ${first.file} and ${page.source.file}.`,
        { pos: page.source, help: `Change the \`permalink\` or rename one of them. The other page is ${first.file}.` },
      );
      return;
    }
    seen.set(page.url, page.source);
    pages.push(page);
    if (page.kind === "doc") {
      folderPages.push({
        path,
        url: page.url,
        title: page.title,
        ...(typeof order === "number" ? { order } : {}),
      });
    }
  };

  for (const file of files) {
    if (file.kind === "app") {
      const folder = file.path.split("/")[0]!;
      const isRootFile = !file.path.includes("/");
      if (isRootFile || appRoots.has(folder)) continue;
      appRoots.add(folder);
      const indexFile = fileOf(`${folder}/index.html`);
      const lang = pageLang(`${folder}/index.html`, { config });
      add(
        {
          url: appUrl(folder, config.base),
          source: posOf(indexFile, 1),
          frontMatter: {},
          title: folder,
          lang: lang.lang,
          dir: lang.dir,
          headings: [],
          html: "",
          markdown: "",
          kind: "app",
        },
        `${folder}/index.html`,
        undefined,
      );
      continue;
    }
    if (file.kind !== "doc") continue;

    const text = await readFile(join(sourceDir, file.path), "utf8");
    const rel = fileOf(file.path);
    const fm = parseFrontMatter(text, rel);
    for (const d of fm.diagnostics) diagnostics.report(d);

    const frontMatter = withDefaults(fm.data, file.path, config.defaults);
    if (frontMatter.published === false) continue;

    const isMarkdown = /\.(md|markdown)$/i.test(file.path);
    // Includes expand before the Markdown stage: only here is the site root known, so a Markdown plugin cannot read
    // the included file. The expanded body is the page's Markdown from then on, so twins, search, and links see it.
    let body = fm.body;
    if (isMarkdown) {
      const included = await expandIncludes({
        body: fm.body,
        bodyLine: fm.bodyLine,
        file: file.path,
        sourceDir,
        displayFile: rel,
      });
      for (const d of included.diagnostics) diagnostics.report(d);
      body = included.body;
    }
    let tree: Root;
    if (!isMarkdown) {
      tree = { type: "root", children: [] };
    } else if (cache !== undefined) {
      const result = await parseMarkdownWithCache(body, fm.bodyLine, cache);
      if (result.parsed) parsedPages += 1;
      tree = result.tree;
    } else {
      tree = await parseMarkdown(body, fm.bodyLine);
      parsedPages += 1;
    }
    const { title } = resolveTitle({ frontMatter, tree, file: file.path });
    const lang = pageLang(file.path, { config, frontMatter });
    const url = permalink(file.path, {
      base: config.base,
      ...(typeof frontMatter.permalink === "string" ? { permalink: frontMatter.permalink } : {}),
    });

    let html = body;
    let headings: Heading[] = [];
    if (isMarkdown) {
      const out = await markdownToHtml(tree, rel);
      html = out.html;
      headings = headingsOf(tree, out.headings, rel);
    }

    add(
      {
        url,
        source: posOf(rel, fm.bodyLine),
        frontMatter,
        title,
        lang: lang.lang,
        dir: lang.dir,
        headings,
        html,
        markdown: body,
        kind: "doc",
      },
      file.path,
      frontMatter.order,
    );
  }

  pages.sort((a, b) => byCodePoint(a.url, b.url));

  const navFile = resolve(siteRoot, config.navigation);
  const navRel = relative(siteRoot, navFile).split("\\").join("/");
  const navResult = loadNavigation(navFile, navRel, { pages: new Set(pages.map((p) => p.url)), base: config.base });
  for (const d of navResult.diagnostics) diagnostics.report(d);
  const nav: NavTree =
    Object.keys(navResult.nav).length > 0 ? navResult.nav : { docs: navFromFolders(folderPages) };

  const data = await loadData(sourceDir, files);
  for (const d of data.diagnostics) diagnostics.report(d);

  // Derived facts run last, once the pages and `_data` are final, and land at `data[fact.name]`; `_data` wins.
  const applied = await applyFacts({
    site: { config, pages, nav, data: data.data },
    root: siteRoot,
    sourceDir,
  });
  for (const d of applied.diagnostics) diagnostics.report(d);

  return {
    site: applied.site,
    diagnostics: sortDiagnostics(diagnostics.all),
    parsedPages,
  };
}
