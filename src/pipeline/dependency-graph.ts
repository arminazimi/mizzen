/**
 * An explicit dependency graph over one site's content, so incremental work has one reliable invalidation unit.
 *
 * A node is a file the build reads (page, include, data, navigation, asset) or an output it derives from them. An
 * edge points from the dependent to what it depends on: a page to its includes, an include to its nested includes,
 * a page or include to a site asset its front matter or Markdown body names, and every page output to its page, the
 * navigation, and `_data`. One node exists per file, so a snippet that is also a page is one unit rather than two.
 *
 * The graph is a superset of the truth where the engine cannot narrow it: a layout may read any `_data` value, so
 * every output depends on every data file. That is deliberate; a narrower edge would make invalidation wrong.
 *
 * Sources are read through the existing `expandIncludes` and `parseFrontMatter`, so include rules (fences, nesting,
 * cycles) stay in one place. The graph is not wired into `build`; it is a standalone unit the integration issue uses.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { Definition, Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { discover, type DiscoveredFile } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { expandIncludes } from "../content/includes.ts";
import type { Diagnostic, Page, Site, SourcePos } from "../contracts/index.ts";
import { sortDiagnostics } from "./diagnostics.ts";

/** What a node stands for. A file has one kind: its role in the build, with discovery's role winning. */
export type DependencyNodeKind = "page" | "include" | "data" | "navigation" | "asset" | "output";

/** One unit of the build. */
export interface DependencyNode {
  /** Stable identity. A source file is `file:<source-relative path>`; a page output is `output:<url>`. */
  readonly id: string;
  /** What the unit is. */
  readonly kind: DependencyNodeKind;
  /** Path relative to the source folder for a file, relative to the site root for navigation, or the URL of an output. */
  readonly path: string;
  /** True when the build computes this node rather than reading it, such as navigation built from folders. */
  readonly derived?: boolean;
  /** True when a dependency names this file but it does not exist. Such a node has an error diagnostic. */
  readonly missing?: boolean;
}

/** One dependency: `from` does not build correctly unless `to` is current. */
export interface DependencyEdge {
  /** Id of the dependent node. */
  readonly from: string;
  /** Id of the dependency. */
  readonly to: string;
  /** Where the dependency is declared, when that is a source position. */
  readonly pos?: SourcePos;
}

/** The graph: nodes and edges, both sorted by their stable keys. */
export interface DependencyGraph {
  /** Every node, sorted by id. */
  readonly nodes: readonly DependencyNode[];
  /** Every edge, sorted by `from`, then `to`, then position; duplicate edges are collapsed. */
  readonly edges: readonly DependencyEdge[];
}

/** What {@link buildDependencyGraph} needs. */
export interface DependencyGraphOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The model built from `root`, read for pages, their URLs, the config, and the navigation path. */
  readonly site: Site;
  /** Files discovery found. Default: run discovery again on the source folder. */
  readonly files?: readonly DiscoveredFile[];
}

/** What {@link buildDependencyGraph} returns. */
export interface DependencyGraphResult {
  /** The graph, even when `diagnostics` holds errors. */
  readonly graph: DependencyGraph;
  /** Missing dependencies, cycles, and the include problems the expansion reported, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Prefix of a source-file node id. */
const FILE = "file:";

/** Prefix of a page-output node id. */
const OUTPUT = "output:";

/** Id of the navigation node when there is no navigation file and the folders build it. */
const GENERATED_NAV = "navigation:generated";

/** Prefix of a navigation node id. It is not a source-relative file id, because the file lives under the site root. */
const NAVIGATION = "navigation:";

/** The id of the node for a source-relative file path. */
export function fileNodeId(path: string): string {
  return `${FILE}${normalize(path)}`;
}

/** The id of the node for a page output at `url`. */
export function outputNodeId(url: string): string {
  return `${OUTPUT}${url}`;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A path as the source folder spells it: `/`-separated, with no leading `./`. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Orders two positions, with a missing position last. */
function comparePos(a: SourcePos | undefined, b: SourcePos | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return (
    byCodePoint(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

function compareNodes(a: DependencyNode, b: DependencyNode): number {
  return byCodePoint(a.id, b.id);
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to) || comparePos(a.pos, b.pos);
}

/** A key that makes duplicate edges collapse, including the position that explains each one. */
function edgeKey(edge: DependencyEdge): string {
  const pos = edge.pos;
  if (pos === undefined) return `${edge.from}\u0000${edge.to}`;
  return `${edge.from}\u0000${edge.to}\u0000${pos.file}\u0000${pos.line}\u0000${pos.column}\u0000${pos.endLine}\u0000${pos.endColumn}`;
}

function sortedEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  const unique = new Map<string, DependencyEdge>();
  for (const edge of edges) if (!unique.has(edgeKey(edge))) unique.set(edgeKey(edge), edge);
  return [...unique.values()].sort(compareEdges);
}

/** The position at the start of a file, for a dependency whose span is not known. */
function atFile(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * A path with every `%`-escape decoded against the `/`-separated segment it sits in, so an encoded separator can
 * never become one. `undefined` when an escape is malformed or decodes to a separator or a NUL: such a reference
 * names no file, and guessing one would put a misleading node in the graph. A segment with no `%` is left exactly
 * as written, so a reference that was never encoded is unaffected.
 *
 * A caller must re-check confinement on the result, since a decoded segment can spell `..` that the written form
 * spelled as `%2e%2e`.
 */
function decodeSegments(value: string): string | undefined {
  if (!value.includes("%")) return value;
  const segments = value.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (!segment.includes("%")) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (decoded === "" || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) return undefined;
    segments[index] = decoded;
  }
  return segments.join("/");
}

/** A source-relative path named by a site-local URL such as `/media/logo.svg`, with `base` removed. */
function localPath(url: string, base: string): string | undefined {
  const clean = url.split(/[?#]/, 1)[0] ?? "";
  if (!clean.startsWith("/")) return undefined;
  if (base !== "" && clean !== base && !clean.startsWith(`${base}/`)) return undefined;
  const withoutBase = base !== "" ? clean.slice(base.length) : clean;
  const encoded = withoutBase.replace(/^\/+/, "");
  if (encoded === "") return undefined;
  const path = decodeSegments(encoded);
  if (path === undefined) return undefined;
  if (path.split("/").some((segment) => segment === "..")) return undefined;
  return path;
}

/** A scheme (`https:`, `mailto:`) or protocol-relative URL, which names no file in the source folder. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * The source-relative path an image URL names from `from`: a root URL goes through {@link localPath}, a relative
 * one resolves from the file that holds it. `undefined` for an external URL, one with a malformed escape, or one
 * that leaves the source folder. Escapes are decoded before the path is resolved, so the edge names the file the
 * built URL reaches, and the parent-segment check runs on the decoded path.
 */
function referencePath(url: string, base: string, from: string): string | undefined {
  if (url === "" || url.startsWith("#") || EXTERNAL.test(url)) return undefined;
  const clean = url.split(/[?#]/, 1)[0] ?? "";
  if (clean === "") return undefined;
  if (clean.startsWith("/")) return localPath(clean, base);
  const path = decodeSegments(clean);
  if (path === undefined || EXTERNAL.test(path)) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(normalize(from)), path));
  if (resolved === "" || resolved === "." || resolved === ".." || resolved.startsWith("../")) return undefined;
  return resolved;
}

/** An image reference found in a Markdown body: its URL and where it starts. */
interface AssetReference {
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** True when a Markdown body is worth parsing for image references. */
const MAY_HAVE_IMAGE = /!\[/;

function walkMdast(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walkMdast(child, visit);
}

/**
 * Every image reference in one Markdown body, with the line and column where it starts (1-based within `body`).
 * Reference-style images resolve through their definitions, and unused definitions are ignored.
 */
function assetReferencesOf(body: string): AssetReference[] {
  if (!MAY_HAVE_IMAGE.test(body)) return [];
  const tree = unified().use(remarkParse).parse(body) as Root;
  const definitions = new Map<string, Definition>();
  walkMdast(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
  });

  const found: AssetReference[] = [];
  const add = (url: string, at: Nodes["position"]): void => {
    if (url === "" || url.startsWith("#") || EXTERNAL.test(url)) return;
    const start = at?.start;
    const end = at?.end;
    if (start === undefined || end === undefined) return;
    found.push({ url, line: start.line, column: start.column, endLine: end.line, endColumn: end.column });
  };
  walkMdast(tree, (node) => {
    if (node.type === "image") add(node.url, node.position);
    else if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition !== undefined) add(definition.url, node.position);
    }
  });
  return found;
}

/** The source path of the page whose source file is `page.source.file`; the longest matching discovery path wins. */
function sourcePathOf(file: string, paths: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const path of paths) {
    if (file === path || file.endsWith(`/${path}`)) {
      if (best === undefined || path.length > best.length) best = path;
    }
  }
  return best;
}

/** Rotates a cycle so it starts at its smallest id, which makes one cycle one key. */
function rotate(cycle: readonly string[]): string[] {
  let first = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i]! < cycle[first]!) first = i;
  return [...cycle.slice(first), ...cycle.slice(0, first)];
}

function cycleKey(cycle: readonly string[]): string {
  return rotate(cycle).join("\u0000");
}

/**
 * Every cycle of the directed graph, once each, by id, starting at the smallest id. Depth-first traversal runs on an
 * explicit stack, so a chain deeper than the JavaScript call stack is analyzed rather than overflowing it.
 */
export function findCycles(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const targets of adjacency.values()) targets.sort(byCodePoint);

  const state = new Map<string, 1 | 2>();
  /** The path being traversed, each step remembering the next adjacency index to read. */
  const path: { id: string; next: number }[] = [];
  const cycles = new Map<string, string[]>();

  for (const node of nodes) {
    if (state.get(node.id) !== undefined) continue;
    state.set(node.id, 1);
    path.push({ id: node.id, next: 0 });
    while (path.length > 0) {
      const step = path[path.length - 1]!;
      const targets = adjacency.get(step.id) ?? [];
      if (step.next >= targets.length) {
        path.pop();
        state.set(step.id, 2);
        continue;
      }
      const next = targets[step.next]!;
      step.next += 1;
      const seen = state.get(next);
      if (seen === 1) {
        const at = path.findIndex((frame) => frame.id === next);
        const cycle = rotate(path.slice(at).map((frame) => frame.id));
        if (!cycles.has(cycleKey(cycle))) cycles.set(cycleKey(cycle), cycle);
      } else if (seen === undefined) {
        state.set(next, 1);
        path.push({ id: next, next: 0 });
      }
    }
  }
  return [...cycles.values()];
}

/**
 * Builds the dependency graph of one site. Reads pages through the existing include expander, so a page's
 * dependencies are the files its own directives name and, transitively, the files those snippets include.
 *
 * A missing include or asset is a node marked `missing` with an error at the referencing line. A cycle is one
 * error per distinct chain, at the edge that closes it. Include findings that already name the problem (`cycle`,
 * `missing`) are replaced by the graph's own diagnostics so one problem is one error.
 */
export async function buildDependencyGraph(options: DependencyGraphOptions): Promise<DependencyGraphResult> {
  const root = resolve(options.root);
  const config = options.site.config;
  const sourceDir = resolve(root, config.source);
  const files = options.files ?? (await discover(sourceDir, { include: config.include, exclude: config.exclude }));

  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  /** Adds a node; a file keeps the role discovery gave it, and a missing reference still marks it. */
  const addNode = (node: DependencyNode): void => {
    const previous = nodes.get(node.id);
    if (previous === undefined) {
      nodes.set(node.id, node);
    } else if (node.missing === true && previous.missing !== true) {
      nodes.set(node.id, { ...previous, missing: true });
    }
  };

  const addEdge = (from: string, to: string, pos?: SourcePos): void => {
    edges.push({ from, to, ...(pos === undefined ? {} : { pos }) });
  };

  const navigationPath = normalize(config.navigation);
  const navigationFile = resolve(root, config.navigation);
  const hasNavigation = existsSync(navigationFile);
  const navigationId = hasNavigation ? `${NAVIGATION}${navigationPath}` : GENERATED_NAV;
  addNode({
    id: navigationId,
    kind: "navigation",
    path: navigationPath,
    ...(hasNavigation ? {} : { derived: true }),
  });

  const discovered = [...files].sort((a, b) => byCodePoint(normalize(a.path), normalize(b.path)));
  const pagePaths: string[] = [];
  const dataIds: string[] = [];
  const filePaths = new Set<string>();

  for (const file of discovered) {
    const path = normalize(file.path);
    filePaths.add(path);
    if (file.kind === "doc") {
      pagePaths.push(path);
      addNode({ id: fileNodeId(path), kind: "page", path });
    } else if (file.kind === "data") {
      if (resolve(sourceDir, path) === navigationFile) continue;
      dataIds.push(fileNodeId(path));
      addNode({ id: fileNodeId(path), kind: "data", path });
    } else {
      addNode({ id: fileNodeId(path), kind: "asset", path });
    }
  }

  const pageByPath = new Map<string, Page>();
  for (const page of options.site.pages) {
    if (page.kind !== "doc") continue;
    const path = sourcePathOf(page.source.file, pagePaths);
    if (path !== undefined) pageByPath.set(path, page);
  }

  const addAssetEdge = (from: string, image: string, pos?: SourcePos): void => {
    const path = referencePath(image, config.base, from);
    if (path === undefined) return;
    if (!filePaths.has(path)) addNode({ id: fileNodeId(path), kind: "asset", path, missing: true });
    addEdge(fileNodeId(from), fileNodeId(path), pos ?? atFile(from));
  };

  /** Adds an edge for every image `body` names, with its line inside the source file that holds the body. */
  const addBodyAssetEdges = (path: string, body: string, bodyLine: number): void => {
    for (const reference of assetReferencesOf(body)) {
      addAssetEdge(path, reference.url, {
        file: path,
        line: bodyLine + reference.line - 1,
        column: reference.column,
        endLine: bodyLine + reference.endLine - 1,
        endColumn: reference.endColumn,
      });
    }
  };

  const includePaths = new Set<string>();

  for (const path of pagePaths) {
    const source = await readFile(resolve(sourceDir, path), "utf8");
    const front = parseFrontMatter(source, path);
    if (typeof front.data.image === "string") addAssetEdge(path, front.data.image);
    addBodyAssetEdges(path, front.body, front.bodyLine);

    const included = await expandIncludes({
      body: front.body,
      bodyLine: front.bodyLine,
      file: path,
      sourceDir,
      displayFile: path,
    });
    for (const diagnostic of included.diagnostics) {
      if (diagnostic.id === "include.cycle" || diagnostic.id === "include.missing") continue;
      diagnostics.push(diagnostic);
    }
    for (const dependency of included.includes) {
      addNode({
        id: fileNodeId(dependency.path),
        kind: "include",
        path: dependency.path,
        ...(dependency.missing ? { missing: true } : {}),
      });
      addNode({ id: fileNodeId(dependency.from), kind: "include", path: dependency.from });
      addEdge(fileNodeId(dependency.from), fileNodeId(dependency.path), dependency.pos);
      if (!dependency.missing) includePaths.add(dependency.path);
    }
  }

  // A snippet's own images are the snippet's dependencies; the pages that include it inherit them transitively.
  // Included files are not discovered (their folder starts with `_`), so the expander's list is the source of truth.
  for (const path of [...includePaths].sort(byCodePoint)) {
    let source: string;
    try {
      source = await readFile(resolve(sourceDir, path), "utf8");
    } catch {
      continue; // An unreadable snippet is already the expander's diagnostic; it has no body to read here.
    }
    const front = parseFrontMatter(source, path);
    addBodyAssetEdges(path, front.body, front.bodyLine);
  }

  for (const [path, page] of pageByPath) {
    const outputId = outputNodeId(page.url);
    addNode({ id: outputId, kind: "output", path: page.url });
    addEdge(outputId, fileNodeId(path));
    addEdge(outputId, navigationId);
    for (const dataId of dataIds) addEdge(outputId, dataId);
  }

  // Navigation built from folders reads every page's title, so it depends on all of them. A navigation file does not.
  if (!hasNavigation) {
    for (const path of pageByPath.keys()) addEdge(navigationId, fileNodeId(path));
  }

  const graphNodes = [...nodes.values()].sort(compareNodes);
  const graphEdges = sortedEdges(edges);
  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));

  for (const node of graphNodes) {
    if (node.missing !== true) continue;
    const references = graphEdges.filter((edge) => edge.to === node.id);
    if (references.length === 0) {
      diagnostics.push({
        id: "dependency.missing",
        severity: "error",
        message: `The dependency ${node.path} does not exist.`,
        help: `Create ${node.path}, or remove the dependency.`,
      });
      continue;
    }
    for (const edge of references) {
      const at = edge.pos === undefined ? "" : ` at ${edge.pos.file}:${edge.pos.line}`;
      diagnostics.push({
        id: "dependency.missing",
        severity: "error",
        message: `The dependency ${node.path} does not exist; it is referenced${at}.`,
        ...(edge.pos === undefined ? {} : { pos: edge.pos }),
        help: `Create ${node.path}, or change the path where it is referenced.`,
      });
    }
  }

  for (const cycle of findCycles(graphNodes, graphEdges)) {
    const first = cycle[0]!;
    const closing = graphEdges.find((edge) => edge.from === cycle.at(-1) && edge.to === first);
    const chain = [...cycle, first].map((id) => nodeById.get(id)?.path ?? id).join(" → ");
    diagnostics.push({
      id: "dependency.cycle",
      severity: "error",
      message: `Dependency cycle: ${chain}.`,
      ...(closing?.pos === undefined ? {} : { pos: closing.pos }),
      help: `Remove one of these dependencies so the chain no longer returns to ${nodeById.get(first)?.path ?? first}.`,
    });
  }

  return {
    graph: { nodes: graphNodes, edges: graphEdges },
    diagnostics: sortDiagnostics(diagnostics),
  };
}

/**
 * The ids of every node transitively affected by a change to `changed`, sorted.
 *
 * `changed` values are matched against node ids and source paths, so a caller can pass a discovered path. The
 * changed nodes themselves are not in the result: they are inputs, and their dependents are what gets rebuilt.
 * A deleted include or asset is still a node marked `missing`, so its dependents are found the same way.
 */
export function affectedNodes(graph: DependencyGraph, changed: readonly string[]): string[] {
  const seeds = new Set<string>();
  for (const value of changed) {
    for (const node of graph.nodes) {
      if (node.id === value || node.path === value) seeds.add(node.id);
    }
  }
  if (seeds.size === 0) return [];

  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = dependents.get(edge.to);
    if (list === undefined) dependents.set(edge.to, [edge.from]);
    else if (!list.includes(edge.from)) list.push(edge.from);
  }

  const affected = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const dependent of dependents.get(id) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return [...affected].filter((id) => !seeds.has(id)).sort(byCodePoint);
}

/**
 * The graph as JSON with a trailing newline. Nodes and edges are sorted here too, so two graphs built from the
 * same files serialize identically whatever order discovery or insertion used.
 */
export function serializeDependencyGraph(graph: DependencyGraph): string {
  const nodes = [...graph.nodes].sort(compareNodes).map((node) => ({
    id: node.id,
    kind: node.kind,
    path: node.path,
    ...(node.derived === true ? { derived: true } : {}),
    ...(node.missing === true ? { missing: true } : {}),
  }));
  const edges = sortedEdges(graph.edges).map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.pos === undefined
      ? {}
      : {
          pos: {
            file: edge.pos.file,
            line: edge.pos.line,
            column: edge.pos.column,
            endLine: edge.pos.endLine,
            endColumn: edge.pos.endColumn,
          },
        }),
  }));
  return `${JSON.stringify({ version: 1, nodes, edges }, null, 2)}\n`;
}
