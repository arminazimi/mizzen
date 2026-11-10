import type { Link, LinkReference, Nodes, Root } from "mdast";
import { posix } from "node:path";
import { permalink } from "../../content/permalink.ts";
import type { Plugin } from "unified";

/**
 * Rewrites links to source `.md` files into their page URLs, and marks external links with
 * `rel="external"` on the rendered `<a>`.
 *
 * Authors link to source files (`../install.md#step-2`); readers get the page URL. A link resolves
 * relative to the page's own source directory and keeps its anchor, so `./index.md`,
 * `guide/README.md`, and `../commands.md#run` turn into `/reference/`, `/guide/`, and
 * `/commands/#run` through the pretty-URL rules ({@link permalink}).
 *
 * External links (a scheme such as `https:` or `mailto:`, or protocol-relative `//`) keep their URL
 * and gain `rel="external"`; the attribute lands in the node's `data.hProperties`, where
 * HTML generation reads it. Same-page anchors (`#intro`) stay put, and a site-absolute `.md` link
 * (`/install.md`) names its source path from the site root.
 *
 * The processor is shared and `parseMarkdown` receives no page context, so the pipeline announces
 * each page with {@link setLinksPagePath} before parsing and clears it after. Without a page path,
 * `.md` links stay unchanged rather than guessed.
 */

/** Source-path extension that marks a link as pointing at a page's source file. */
const PAGE_LINK = /\.(?:md|markdown)$/i;

/** A scheme (`https:`, `mailto:`) or protocol-relative (`//`) URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** The source path (`a/b.md`) of the page being parsed, for the duration of one parse. */
let pagePath: string | undefined;

/** Announce the page being parsed, so relative `.md` links resolve against its directory. */
export function setLinksPagePath(path: string | undefined): void {
  pagePath = path;
}

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** Splits a URL into its path and its `#anchor` ("" when there is none). */
function splitAnchor(url: string): { path: string; anchor: string } {
  const at = url.indexOf("#");
  return at === -1 ? { path: url, anchor: "" } : { path: url.slice(0, at), anchor: url.slice(at) };
}

/** The page URL for a relative `.md` link, or `undefined` when the plugin leaves it alone. */
function pageUrlOf(url: string): string | undefined {
  if (pagePath === undefined) return undefined;
  if (EXTERNAL.test(url)) return undefined;
  const { path, anchor } = splitAnchor(url);
  if (!PAGE_LINK.test(path)) return undefined;
  // A site-absolute link (`/install.md`) already names its source path from the root; a relative
  // one (`../install.md`) resolves against the page's own directory.
  const source = path.startsWith("/")
    ? path.slice(1)
    : posix.normalize(posix.join(posix.dirname(pagePath.replace(/\\/g, "/")), path));
  return permalink(source) + anchor;
}

/** Adds `rel="external"` to a link node's HTML attributes, keeping any `rel` already set. */
function markExternal(node: Link | LinkReference): void {
  const data = (node.data ??= {}) as Record<string, unknown>;
  const props = data.hProperties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    const record = props as Record<string, unknown>;
    const rel = record.rel;
    if (typeof rel === "string" && rel !== "") {
      if (!/\bexternal\b/.test(rel)) record.rel = `${rel} external`;
    } else if (rel === undefined || rel === null || rel === "") {
      record.rel = "external";
    }
  } else {
    data.hProperties = { rel: "external" };
  }
}

export const name = "links";
export const order = 10;
export const plugin: Plugin<[], Root> = () => (tree) => {
  // Reference-style links resolve through their definitions at HTML time, so definitions are
  // rewritten first and the references read the rewritten target to decide `rel`.
  const targets = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type !== "definition") return;
    const pageUrl = pageUrlOf(node.url);
    if (pageUrl !== undefined) node.url = pageUrl;
    targets.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === "link") {
      const pageUrl = pageUrlOf(node.url);
      if (pageUrl !== undefined) node.url = pageUrl;
      else if (EXTERNAL.test(node.url)) markExternal(node);
      return;
    }
    if (node.type === "linkReference") {
      const target = targets.get(node.identifier);
      if (target !== undefined && EXTERNAL.test(target)) markExternal(node);
    }
  });
};
