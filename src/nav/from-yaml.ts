import { existsSync, readFileSync } from "node:fs";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from "yaml";
import type { Diagnostic, NavGroup, NavItem, NavLink, NavTree, SourcePos } from "../contracts/index.ts";

import { createDiagnostics, type Diagnostics } from "../pipeline/diagnostics.ts";

/** A list name the file may use: `main` and `docs`, or either with a language suffix such as `docs_fa` (the 0.2 shape). */
const LIST_KEY = /^(main|docs)(_[a-z]{2,3})?$/;

/** A path on this site, or an https link (the same rule as `schema/navigation.schema.json`). */
const URL_FORM = /^(\/|https:\/\/)[^\s"<>]*$/;

/** A site-local path prefix, the `match` of a generated section. */
const MATCH_FORM = /^\/[^\s"<>]*$/;

/**
 * The `tab` mark the theme's section tabs read. It is not part of the frozen `NavItem` contract, so it stays
 * an extra key on the returned item, which the theme reads with `"tab" in item` (see `chrome/section-tabs`).
 */
interface Tabbed {
  readonly tab?: boolean;
}

/** The `tab` mark of one entry, or undefined when it has none. Reports an error for a value that is not a boolean. */
function tabOf(ctx: Context, map: YAMLMap): boolean | undefined {
  const node = valueOf(map, "tab");
  if (node === undefined) return undefined;
  if (!isScalar(node) || typeof node.value !== "boolean") {
    ctx.diagnostics.error("nav.invalid-tab", "`tab` is `true` or `false`.", {
      pos: posOf(ctx, node),
      help: "Mark a top-level section as a header tab with `tab: true`.",
    });
    return undefined;
  }
  return node.value === true ? true : undefined;
}

/** Options of {@link navFromYaml}. */
export interface NavFromYamlOptions {
  /**
   * Site-local URLs of the pages that exist, `base` included. When set, a site-local link to any other URL is a
   * warning with the YAML line. Leave it out to check only the shape of the file.
   */
  readonly pages?: ReadonlySet<string>;
  /**
   * Site `base` from config: a path starting with `/` and without a trailing slash, or `""` at a domain root.
   * Navigation URLs are written without it and the engine adds it (ADR 0024).
   */
  readonly base?: string;
}

/** What {@link navFromYaml} read from a navigation file. */
export interface NavFromYamlResult {
  /** The navigation lists by name; entries with problems are left out, every other entry still loads. */
  readonly nav: NavTree;
  /** Problems found in the file, each with its line; empty when the file is valid. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Shared state while one file is read. */
interface Context {
  readonly file: string;
  readonly lineCounter: LineCounter;
  readonly pages: ReadonlySet<string> | undefined;
  readonly base: string;
  readonly diagnostics: Diagnostics;
}

/** Prefix a site-local `url` with `base`. `base` is `""` or `/docs`-shaped (no trailing slash). */
function withBase(base: string, url: string): string {
  if (base === "") return url;
  if (url === "/") return `${base}/`;
  return `${base}${url}`;
}

function posOf(ctx: Context, node: Node | null | undefined): SourcePos {
  const range = node?.range;
  if (!range) return { file: ctx.file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  const start = ctx.lineCounter.linePos(range[0]);
  const end = ctx.lineCounter.linePos(Math.max(range[0], (range[2] ?? range[1]) - 1));
  return { file: ctx.file, line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
}

function textOf(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

/** The value node stored under `key`, or undefined. */
function valueOf(map: YAMLMap, key: string): Node | undefined {
  for (const pair of map.items) {
    if (textOf(pair.key) === key) return pair.value as Node;
  }
  return undefined;
}

/** Reads one link (`title`, `url`, optional `match` and `tab`). Returns undefined after reporting why it is not one. */
function link(ctx: Context, map: YAMLMap): (NavLink & Tabbed) | undefined {
  const allowed = new Set(["title", "url", "match", "tab"]);
  for (const pair of map.items) {
    const key = textOf(pair.key) ?? "";
    if (!allowed.has(key)) {
      ctx.diagnostics.error("nav.unknown-key", `Unknown key \`${key}\` in a navigation link.`, {
        pos: posOf(ctx, pair.key as Node),
        help: "A link has `title`, `url`, an optional `match`, and an optional `tab`; a group has `title`, `children`, and an optional `tab`.",
      });
    }
  }

  const title = textOf(valueOf(map, "title"));
  const url = textOf(valueOf(map, "url"));
  if (title === undefined || title === "") {
    ctx.diagnostics.error("nav.invalid-item", "A navigation link needs a non-empty `title`.", { pos: posOf(ctx, map) });
    return undefined;
  }
  if (url === undefined) {
    ctx.diagnostics.error("nav.invalid-item", `The navigation link \`${title}\` needs a \`url\`.`, { pos: posOf(ctx, map) });
    return undefined;
  }

  const urlNode = valueOf(map, "url");
  if (!URL_FORM.test(url)) {
    ctx.diagnostics.error("nav.invalid-url", `Unknown URL \`${url}\`: a navigation URL is a path starting with \`/\` or an https link.`, {
      pos: posOf(ctx, urlNode),
      help: "Write the path from the site root, such as `/install/`.",
    });
    return undefined;
  }
  const siteLocal = url.startsWith("/");
  const href = siteLocal ? withBase(ctx.base, url) : url;
  if (siteLocal && ctx.pages !== undefined && !ctx.pages.has(href)) {
    ctx.diagnostics.warn("nav.unknown-url", `No page at \`${url}\`.`, {
      pos: posOf(ctx, urlNode),
      help: "Link to a page that exists, or add the page.",
    });
  }

  const matchNode = valueOf(map, "match");
  const match = textOf(matchNode);
  if (matchNode !== undefined && (match === undefined || !MATCH_FORM.test(match))) {
    ctx.diagnostics.error("nav.invalid-match", "`match` is a path prefix starting with `/`.", { pos: posOf(ctx, matchNode) });
    return undefined;
  }

  const tab = tabOf(ctx, map);
  return {
    title,
    url: href,
    ...(match === undefined ? {} : { match: withBase(ctx.base, match) }),
    ...(tab === undefined ? {} : { tab }),
  };
}

/** Reads one entry of a list: a link, or a group of links. Returns undefined after reporting why it is neither. */
function entry(ctx: Context, node: Node): NavItem | undefined {
  if (!isMap(node)) {
    ctx.diagnostics.error("nav.invalid-item", "Each navigation entry is a mapping with `title` and `url`, or `title` and `children`.", {
      pos: posOf(ctx, node),
    });
    return undefined;
  }

  const childrenNode = valueOf(node, "children");
  if (childrenNode === undefined) return link(ctx, node);

  for (const pair of node.items) {
    const key = textOf(pair.key) ?? "";
    if (key !== "title" && key !== "children" && key !== "tab") {
      ctx.diagnostics.error("nav.unknown-key", `Unknown key \`${key}\` in a navigation group.`, {
        pos: posOf(ctx, pair.key as Node),
        help: "A group has `title`, `children`, and an optional `tab`; a group holds links only.",
      });
    }
  }

  const title = textOf(valueOf(node, "title"));
  if (title === undefined || title === "") {
    ctx.diagnostics.error("nav.invalid-item", "A navigation group needs a non-empty `title`.", { pos: posOf(ctx, node) });
    return undefined;
  }
  if (!isSeq(childrenNode) || childrenNode.items.length === 0) {
    ctx.diagnostics.error("nav.invalid-item", `The navigation group \`${title}\` needs at least one link under \`children\`.`, {
      pos: posOf(ctx, childrenNode),
    });
    return undefined;
  }

  const children: NavLink[] = [];
  for (const child of childrenNode.items) {
    if (!isMap(child)) {
      ctx.diagnostics.error("nav.invalid-item", "Each child of a navigation group is a link with `title` and `url`.", {
        pos: posOf(ctx, child as Node),
      });
      continue;
    }
    const found = link(ctx, child);
    if (found !== undefined) children.push(found);
  }
  if (children.length === 0) return undefined;
  const tab = tabOf(ctx, node);
  const group: NavGroup & Tabbed = {
    title,
    children,
    ...(tab === undefined ? {} : { tab }),
  };
  return group;
}

/**
 * Reads a navigation file (`_data/navigation.yml`, the 0.2 shape) into lists by name. `main` is the header menu and `docs`
 * the sidebar, in reading order; `main_<lang>` and `docs_<lang>` hold a language's own lists. A list entry is a link
 * (`title`, `url`, optional `match` and `tab`) or a group (`title`, one level of `children`, and optional `tab`).
 *
 * `tab: true` marks a top-level entry as a section tab in the header; it stays an extra key on the returned item because
 * `NavItem` is frozen.
 *
 * Every problem carries the YAML line it is on. A malformed URL, an unknown key, an unknown list, or an invalid entry is an
 * error and that entry is left out; the rest of the file still loads. A site-local URL that is not in `options.pages` is a
 * warning. Site-local URLs and `match` prefixes are returned with `options.base` in front (ADR 0024). `file` names the
 * file in diagnostic positions.
 */
export function navFromYaml(text: string, file: string, options: NavFromYamlOptions = {}): NavFromYamlResult {
  const source = text.replace(/^﻿/, "");
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const ctx: Context = {
    file,
    lineCounter,
    pages: options.pages,
    base: options.base ?? "",
    diagnostics: createDiagnostics(),
  };

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      const end = error.linePos?.[1] ?? start;
      ctx.diagnostics.error("nav.invalid-yaml", `Invalid YAML in ${file}: ${error.message.split("\n")[0]}`, {
        pos: {
          file,
          line: start?.line ?? 1,
          column: start?.col ?? 1,
          endLine: end?.line ?? start?.line ?? 1,
          endColumn: end?.col ?? start?.col ?? 1,
        },
      });
    }
    return { nav: {}, diagnostics: ctx.diagnostics.all };
  }

  const root = doc.contents;
  if (root === null || root === undefined) return { nav: {}, diagnostics: [] };
  if (!isMap(root)) {
    ctx.diagnostics.error("nav.not-a-mapping", "The navigation file is a mapping of list names (`main`, `docs`) to lists.", {
      pos: posOf(ctx, root),
    });
    return { nav: {}, diagnostics: ctx.diagnostics.all };
  }

  const nav: Record<string, NavItem[]> = {};
  for (const pair of root.items) {
    const name = textOf(pair.key) ?? "";
    const keyPos = posOf(ctx, pair.key as Node);
    if (!LIST_KEY.test(name)) {
      ctx.diagnostics.error("nav.unknown-list", `Unknown navigation list \`${name}\`.`, {
        pos: keyPos,
        help: "Use `main` (header menu) or `docs` (sidebar), or add a language suffix such as `docs_fa`.",
      });
      continue;
    }
    const list = pair.value as Node;
    if (!isSeq(list)) {
      ctx.diagnostics.error("nav.invalid-list", `The navigation list \`${name}\` is a list of entries.`, { pos: posOf(ctx, list) });
      continue;
    }
    const items: NavItem[] = [];
    for (const item of list.items) {
      const found = entry(ctx, item as Node);
      if (found !== undefined) items.push(found);
    }
    nav[name] = items;
  }

  return { nav, diagnostics: ctx.diagnostics.all };
}

/**
 * Reads the navigation file at `path` with {@link navFromYaml}. The file is optional: a missing file is an empty
 * navigation with no diagnostics, as a site without navigation is a valid site.
 */
export function loadNavigation(path: string, file: string, options: NavFromYamlOptions = {}): NavFromYamlResult {
  if (!existsSync(path)) return { nav: {}, diagnostics: [] };
  return navFromYaml(readFileSync(path, "utf8"), file, options);
}
