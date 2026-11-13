/**
 * Issue #149: cycle detection must not spend the JavaScript call stack, so a dependency chain deeper than the
 * engine's recursion limit is analyzed instead of throwing RangeError. The cycle semantics are unchanged: one
 * finding per cycle, rotated to its smallest id, with the edge that closes it.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import {
  buildDependencyGraph,
  fileNodeId,
  findCycles,
  type DependencyEdge,
  type DependencyNode,
  type DependencyGraphResult,
} from "../src/pipeline/dependency-graph.ts";

/** Far past the ten-thousand-odd frames a recursive traversal gets before RangeError on every supported Node. */
const DEPTH = 50_000;

/** A page node whose id sorts by `index`. */
function nodeAt(index: number): DependencyNode {
  const path = `node-${String(index).padStart(6, "0")}.md`;
  return { id: fileNodeId(path), kind: "page", path };
}

/** A page node with a readable id. */
function named(name: string): DependencyNode {
  return { id: fileNodeId(`${name}.md`), kind: "page", path: `${name}.md` };
}

/** An edge between two node ids. */
function edge(from: string, to: string): DependencyEdge {
  return { from, to };
}

/** The ids of `diagnostics` with `id`, for the tests that count one kind. */
function only(diagnostics: readonly Diagnostic[], id: string): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.id === id);
}

/** Writes every entry of `files` under a fresh temp site, runs `run` in it, and removes the site afterwards. */
async function withSite<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mizzen-dependency-graph-deep-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Builds the model, then the graph, the way the build does. */
async function graphOf(root: string): Promise<DependencyGraphResult> {
  const { site } = await buildModel(root);
  return buildDependencyGraph({ root, site });
}

test("an acyclic chain deeper than the call stack is analyzed without RangeError", () => {
  const nodes = Array.from({ length: DEPTH }, (_, index) => nodeAt(index));
  const edges = Array.from({ length: DEPTH - 1 }, (_, index) => edge(nodes[index]!.id, nodes[index + 1]!.id));

  assert.deepEqual(findCycles(nodes, edges), []);
});

test("a deep cycle is reported once, whole, starting at its smallest id", () => {
  const nodes = Array.from({ length: DEPTH }, (_, index) => nodeAt(index));
  const edges = Array.from({ length: DEPTH - 1 }, (_, index) => edge(nodes[index]!.id, nodes[index + 1]!.id));
  edges.push(edge(nodes[DEPTH - 1]!.id, nodes[0]!.id), edge(nodes[DEPTH - 1]!.id, nodes[0]!.id));

  const cycles = findCycles(nodes, edges);
  assert.equal(cycles.length, 1);
  const cycle = cycles[0]!;
  assert.equal(cycle.length, DEPTH);
  assert.equal(cycle[0], nodes[0]!.id);
  assert.equal(cycle[1], nodes[1]!.id);
  assert.equal(cycle[DEPTH - 1], nodes[DEPTH - 1]!.id);

  // The same graph read again answers the same way, whatever the call stack can hold.
  assert.deepEqual(findCycles(nodes, edges), cycles);
});

test("multiple cycles, self-cycles and repeated edges are reported once each in a deterministic order", () => {
  const nodes = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "m", "n"].map(named);
  const id = (name: string): string => fileNodeId(`${name}.md`);
  const edges = [
    edge(id("a"), id("b")),
    edge(id("a"), id("b")),
    edge(id("b"), id("a")),
    edge(id("a"), id("c")),
    edge(id("c"), id("d")),
    edge(id("d"), id("c")),
    edge(id("e"), id("e")),
    edge(id("f"), id("g")),
    edge(id("g"), id("f")),
    edge(id("h"), id("i")),
    edge(id("i"), id("j")),
    edge(id("j"), id("h")),
    // The cycle is entered from k, so it starts at n, but it is reported from its smallest id, m.
    edge(id("k"), id("n")),
    edge(id("n"), id("m")),
    edge(id("m"), id("n")),
  ];

  assert.deepEqual(
    findCycles(nodes, edges),
    [
      [id("a"), id("b")],
      [id("c"), id("d")],
      [id("e")],
      [id("f"), id("g")],
      [id("h"), id("i"), id("j")],
      [id("m"), id("n")],
    ],
  );
});

test("include cycles keep their canonical chain, one finding each, at the closing edge", async () => {
  const files: Record<string, string> = {
    "mizzen.yml": "title: Deep dependency fixture\nnavigation: _data/navigation.yml\n",
    "_data/navigation.yml": ["a", "b", "c", "d", "e"]
      .map((name) => `  - title: ${name.toUpperCase()}\n    url: /${name}/`)
      .join("\n"),
    "a.md": "---\ntitle: A\n---\n::include[b.md]\n",
    "b.md": "---\ntitle: B\n---\n::include[a.md]\n",
    "c.md": "---\ntitle: C\n---\n::include[d.md]\n",
    "d.md": "---\ntitle: D\n---\n::include[c.md]\n",
    "e.md": "---\ntitle: E\n---\n::include[e.md]\n",
  };

  await withSite(files, async (root) => {
    const { graph, diagnostics } = await graphOf(root);
    const cycles = only(diagnostics, "dependency.cycle");

    assert.deepEqual(
      cycles.map((diagnostic) => diagnostic.message),
      [
        "Dependency cycle: a.md → b.md → a.md.",
        "Dependency cycle: c.md → d.md → c.md.",
        "Dependency cycle: e.md → e.md.",
      ],
    );
    assert.deepEqual(
      cycles.map((diagnostic) => [diagnostic.pos?.file, diagnostic.pos?.line]),
      [
        ["b.md", 4],
        ["d.md", 4],
        ["e.md", 4],
      ],
    );
    assert.deepEqual(only(diagnostics, "dependency.missing"), []);

    // Every edge is in the graph once, including the ones a cycle revisits.
    assert.deepEqual(
      graph.edges.filter((candidate) => candidate.from === candidate.to).map((candidate) => candidate.from),
      [fileNodeId("e.md")],
    );
  });
});
