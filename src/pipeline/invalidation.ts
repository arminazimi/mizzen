/**
 * A deterministic invalidation plan over one site's dependency graph: what changed, which page outputs it affects,
 * the shortest causal chain to each of them, and why a full build is the only safe answer when the graph is
 * incomplete.
 *
 * The graph's edges point from a dependent to a dependency, so a plan walks them forwards: an output reaches its
 * page, the page reaches an include or asset, and the include reaches its nested include. A breadth-first walk from
 * each output therefore gives the shortest chain to every changed input, and a visited set makes duplicate edges
 * and cycles terminate. Nothing is guessed from a partial graph: a rename, a changed path with no node, or an
 * unknown plugin, theme, output, or runtime change makes the plan complete, with every output present and the
 * reason recorded.
 *
 * Outputs are `rebuild` or `delete`: a deleted page's own output must disappear, while outputs that depended on it
 * through the navigation or data still rebuild. Direct causes (an edge from the output itself) and transitive ones
 * are kept apart. Every list is sorted by stable ids, so two equivalent graphs and change sets serialize byte for
 * byte alike.
 */
import type { SourcePos } from "../contracts/index.ts";
import type { DependencyGraph, DependencyNode, DependencyNodeKind } from "./dependency-graph.ts";

/** A source change the caller observed. Paths and node ids are both accepted. */
export type InvalidationChange =
  | { readonly kind: "changed"; readonly path: string }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string };

/** An input outside the graph: the graph cannot see its files, so it can narrow nothing. */
export type GlobalChange = "plugin" | "theme" | "output" | "runtime" | "unknown";

/** What {@link planInvalidation} needs. */
export interface InvalidationPlanOptions {
  /** The graph of the site as it was before the changes. */
  readonly graph: DependencyGraph;
  /** The observed source changes. Each path may be a source path or a node id. */
  readonly changes?: readonly InvalidationChange[];
  /** Changed inputs that have no node or edge in the graph. Any of them forces a complete plan. */
  readonly global?: readonly GlobalChange[];
}

/** Why a complete build is required. */
export type InvalidationReasonKind = GlobalChange | "renamed" | "unknown";

/** One conservative full-build reason, with the detail a person can act on. */
export interface InvalidationReason {
  readonly kind: InvalidationReasonKind;
  readonly detail: string;
}

/** One direct change as the plan records it. */
export interface PlannedChange {
  readonly kind: "changed" | "deleted" | "renamed";
  /** The path after the change; for a rename, the new path. */
  readonly path: string;
  /** The old path of a rename. */
  readonly from?: string;
  /** The graph node the path resolved to, when it has one. */
  readonly node?: string;
}

/** One step of a causal chain, from an output towards the input that changed. */
export interface InvalidationStep {
  /** Node id, or a synthetic id for a change outside the graph. */
  readonly id: string;
  readonly kind: DependencyNodeKind | "external";
  /** Path relative to the source folder, an output URL, or a human label for an external change. */
  readonly path: string;
  /** Where the next step is declared, when the dependency has a source position. */
  readonly pos?: SourcePos;
}

/** One reason an output is affected, with its shortest causal chain. */
export interface InvalidationCause {
  readonly kind: "changed" | "deleted" | "renamed" | "global" | "unknown";
  /** The changed node's id, or a synthetic id for a change outside the graph. */
  readonly node: string;
  /** From the output to the changed input; the first step is this output. */
  readonly chain: readonly InvalidationStep[];
  /** The chain as one line, such as `output:/alpha/ → alpha.md (changed)`. */
  readonly explanation: string;
}

/** What happens to one page output. */
export interface PlannedOutput {
  /** The output node's id. */
  readonly id: string;
  /** The output URL. */
  readonly url: string;
  /** `delete` when the page itself is gone; otherwise the page is rebuilt. */
  readonly action: "rebuild" | "delete";
  /** Changes the output depends on directly, sorted by chain length then node id. */
  readonly direct: readonly InvalidationCause[];
  /** Changes reached through another node, sorted by chain length then node id. */
  readonly transitive: readonly InvalidationCause[];
}

/** The answer: whether every output must be rebuilt, and what to do with each. */
export interface InvalidationPlan {
  /** True when the graph cannot name the affected set, so every output is listed. */
  readonly complete: boolean;
  /** Conservative full-build reasons, sorted; empty for a narrow plan. */
  readonly reasons: readonly InvalidationReason[];
  /** Direct changes, normalized to node ids where possible, sorted by path. */
  readonly changes: readonly PlannedChange[];
  /** Affected outputs only, sorted by id. Unaffected outputs are absent. */
  readonly outputs: readonly PlannedOutput[];
}

/** How strong a change for one node is: a deletion wins over a change. */
const SEED_PRIORITY = { changed: 1, deleted: 2, renamed: 3 } as const;

type SeedKind = keyof typeof SEED_PRIORITY;

/** A change outside the graph, ready to become a cause on every output. */
interface ExternalCause {
  readonly kind: InvalidationCause["kind"];
  readonly node: string;
  readonly label: string;
}

/** One edge of the forward adjacency: what a node depends on. */
interface Link {
  readonly to: string;
  readonly pos?: SourcePos;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** The detail of a changed input that the graph cannot model. */
const GLOBAL_DETAIL: Record<GlobalChange, string> = {
  plugin: "A plugin change can affect every page, and the graph cannot read plugin code.",
  theme: "A theme change can affect every page, and the graph cannot read theme files.",
  output: "An output change can write any file, and the graph cannot read output code.",
  runtime: "A runtime change can change rendered output, and the graph cannot model it.",
  unknown: "An input outside the graph changed, so the graph cannot narrow the rebuild.",
};

/** A node a change names: the id alone, its path, or both. */
function matches(nodes: readonly DependencyNode[], value: string): DependencyNode[] {
  return nodes.filter((node) => node.kind !== "output" && (node.id === value || node.path === value));
}

/** Causes sorted by the shortest chain, then the input's stable id. */
function compareCauses(a: InvalidationCause, b: InvalidationCause): number {
  return a.chain.length - b.chain.length || byCodePoint(a.node, b.node) || byCodePoint(a.kind, b.kind);
}

function sortedCauses(causes: readonly InvalidationCause[]): InvalidationCause[] {
  return [...causes].sort(compareCauses);
}

function compareReasons(a: InvalidationReason, b: InvalidationReason): number {
  return byCodePoint(a.kind, b.kind) || byCodePoint(a.detail, b.detail);
}

function compareChanges(a: PlannedChange, b: PlannedChange): number {
  return (
    byCodePoint(a.path, b.path) ||
    byCodePoint(a.from ?? "", b.from ?? "") ||
    byCodePoint(a.kind, b.kind) ||
    byCodePoint(a.node ?? "", b.node ?? "")
  );
}

/**
 * Plans one rebuild without reading the file system: the graph is the truth about the old build, and the change
 * set is what the caller saw happen since. A narrow plan lists only the outputs whose forward walk reaches a
 * changed node; a complete plan lists every output and carries at least one reason.
 */
export function planInvalidation(options: InvalidationPlanOptions): InvalidationPlan {
  const nodes = [...options.graph.nodes].sort((a, b) => byCodePoint(a.id, b.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const forward = new Map<string, Link[]>();
  for (const node of nodes) forward.set(node.id, []);
  for (const edge of options.graph.edges) {
    const links = forward.get(edge.from);
    if (links === undefined) continue;
    if (links.some((link) => link.to === edge.to && comparePos(link.pos, edge.pos) === 0)) continue;
    links.push({ to: edge.to, ...(edge.pos === undefined ? {} : { pos: edge.pos }) });
  }
  for (const links of forward.values()) links.sort((a, b) => byCodePoint(a.to, b.to) || comparePos(a.pos, b.pos));

  const seeds = new Map<string, SeedKind>();
  const changes: PlannedChange[] = [];
  const reasons = new Map<string, InvalidationReason>();
  const externalByReason = new Map<string, ExternalCause>();

  const addReason = (kind: InvalidationReasonKind, detail: string, external: ExternalCause): void => {
    const key = `${kind}\u0000${detail}`;
    reasons.set(key, { kind, detail });
    externalByReason.set(key, external);
  };

  const addSeed = (id: string, kind: SeedKind): void => {
    const current = seeds.get(id);
    if (current === undefined || SEED_PRIORITY[kind] > SEED_PRIORITY[current]) seeds.set(id, kind);
  };

  for (const change of options.changes ?? []) {
    if (change.kind === "renamed") {
      changes.push({ kind: "renamed", path: change.to, from: change.from });
      for (const node of matches(nodes, change.from)) addSeed(node.id, "renamed");
      addReason(
        "renamed",
        `"${change.from}" was renamed to "${change.to}"; the graph has no node for the new path.`,
        { kind: "renamed", node: `rename:${change.from}->${change.to}`, label: `${change.from} → ${change.to}` },
      );
      continue;
    }

    const found = matches(nodes, change.path);
    if (found.length === 0) {
      changes.push({ kind: change.kind, path: change.path });
      addReason("unknown", `The change to "${change.path}" has no node in the dependency graph.`, {
        kind: "unknown",
        node: `unknown:${change.path}`,
        label: change.path,
      });
      continue;
    }
    for (const node of found) {
      addSeed(node.id, change.kind);
      changes.push({ kind: change.kind, path: node.path, node: node.id });
    }
  }

  for (const kind of new Set(options.global ?? [])) {
    addReason(kind, GLOBAL_DETAIL[kind], { kind: "global", node: `global:${kind}`, label: kind });
  }

  const externalCauses: ExternalCause[] = [...reasons.keys()]
    .sort((a, b) => byCodePoint(a, b))
    .map((key) => externalByReason.get(key)!);

  const deletedPages = new Set(
    [...seeds].filter(([id, kind]) => kind !== "changed" && nodeById.get(id)?.kind === "page").map(([id]) => id),
  );
  const complete = reasons.size > 0;

  /** The shortest walk from `output` to every node it reaches, with the edge that reached each one. */
  const walk = (output: string): Map<string, { readonly prev: string; readonly pos?: SourcePos }> => {
    const reached = new Map<string, { readonly prev: string; readonly pos?: SourcePos }>();
    const seen = new Set<string>([output]);
    const queue = [output];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const link of forward.get(id) ?? []) {
        if (seen.has(link.to)) continue;
        seen.add(link.to);
        reached.set(link.to, { prev: id, ...(link.pos === undefined ? {} : { pos: link.pos }) });
        queue.push(link.to);
      }
    }
    return reached;
  };

  /** The chain from `output` to `seed`, or `[]` when the walk never reached it. */
  const chainOf = (
    output: DependencyNode,
    seed: string,
    reached: ReadonlyMap<string, { readonly prev: string; readonly pos?: SourcePos }>,
  ): InvalidationStep[] => {
    const ids = [seed];
    let current = seed;
    while (current !== output.id) {
      const step = reached.get(current);
      if (step === undefined) return [];
      ids.push(step.prev);
      current = step.prev;
    }
    ids.reverse();
    return ids.map((id, index) => {
      const node = nodeById.get(id);
      const next = ids[index + 1];
      const pos = next === undefined ? undefined : reached.get(next)?.pos;
      return {
        id,
        kind: node?.kind ?? "external",
        path: node?.path ?? id,
        ...(pos === undefined ? {} : { pos }),
      };
    });
  };

  const explanationOf = (chain: readonly InvalidationStep[], kind: InvalidationCause["kind"]): string =>
    `${chain.map((step) => step.path).join(" → ")} (${kind})`;

  const causeOf = (chain: readonly InvalidationStep[], kind: InvalidationCause["kind"], node: string): InvalidationCause => ({
    kind,
    node,
    chain,
    explanation: explanationOf(chain, kind),
  });

  const outputs: PlannedOutput[] = [];
  for (const node of nodes) {
    if (node.kind !== "output") continue;
    const reached = walk(node.id);
    const directLinks = forward.get(node.id) ?? [];
    const direct: InvalidationCause[] = [];
    const transitive: InvalidationCause[] = [];

    for (const [seed, kind] of seeds) {
      const chain = chainOf(node, seed, reached);
      if (chain.length === 0) continue;
      const cause = causeOf(chain, kind, seed);
      if (directLinks.some((link) => link.to === seed)) direct.push(cause);
      else transitive.push(cause);
    }

    if (complete) {
      for (const external of externalCauses) {
        const chain: InvalidationStep[] = [
          { id: node.id, kind: "output", path: node.path },
          { id: external.node, kind: "external", path: external.label },
        ];
        transitive.push(causeOf(chain, external.kind, external.node));
      }
    } else if (direct.length === 0 && transitive.length === 0) {
      continue;
    }

    outputs.push({
      id: node.id,
      url: node.path,
      action: deletedPages.has(node.id) || directLinks.some((link) => deletedPages.has(link.to)) ? "delete" : "rebuild",
      direct: sortedCauses(direct),
      transitive: sortedCauses(transitive),
    });
  }

  outputs.sort((a, b) => byCodePoint(a.id, b.id));

  const uniqueChanges = new Map<string, PlannedChange>();
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.path}\u0000${change.from ?? ""}\u0000${change.node ?? ""}`;
    if (!uniqueChanges.has(key)) uniqueChanges.set(key, change);
  }

  return {
    complete,
    reasons: [...reasons.values()].sort(compareReasons),
    changes: [...uniqueChanges.values()].sort(compareChanges),
    outputs,
  };
}

/** One step as the plan file spells it, with a fixed key order. */
function stepJson(step: InvalidationStep): Record<string, unknown> {
  return {
    id: step.id,
    kind: step.kind,
    path: step.path,
    ...(step.pos === undefined
      ? {}
      : {
          pos: {
            file: step.pos.file,
            line: step.pos.line,
            column: step.pos.column,
            endLine: step.pos.endLine,
            endColumn: step.pos.endColumn,
          },
        }),
  };
}

function causeJson(cause: InvalidationCause): Record<string, unknown> {
  return {
    kind: cause.kind,
    node: cause.node,
    explanation: cause.explanation,
    chain: cause.chain.map(stepJson),
  };
}

/**
 * The plan as JSON with a trailing newline. Every list is sorted here as well, so two plans built from equivalent
 * graphs and change sets are byte-identical whatever order the caller inserted them in.
 */
export function serializeInvalidationPlan(plan: InvalidationPlan): string {
  const reasons = [...plan.reasons].sort(compareReasons).map((reason) => ({ kind: reason.kind, detail: reason.detail }));
  const changes = [...plan.changes].sort(compareChanges).map((change) => ({
    kind: change.kind,
    path: change.path,
    ...(change.from === undefined ? {} : { from: change.from }),
    ...(change.node === undefined ? {} : { node: change.node }),
  }));
  const outputs = [...plan.outputs].sort((a, b) => byCodePoint(a.id, b.id)).map((output) => ({
    id: output.id,
    url: output.url,
    action: output.action,
    direct: sortedCauses(output.direct).map(causeJson),
    transitive: sortedCauses(output.transitive).map(causeJson),
  }));

  return `${JSON.stringify({ version: 1, complete: plan.complete, reasons, changes, outputs }, null, 2)}\n`;
}
