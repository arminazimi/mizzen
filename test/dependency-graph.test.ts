import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import {
  affectedNodes,
  buildDependencyGraph,
  fileNodeId,
  outputNodeId,
  serializeDependencyGraph,
  type DependencyGraphResult,
} from "../src/pipeline/dependency-graph.ts";

const SITE = fileURLToPath(new URL("../fixtures/dependency-graph/site", import.meta.url));
const BROKEN = fileURLToPath(new URL("../fixtures/dependency-graph/broken", import.meta.url));
const GENERATED = fileURLToPath(new URL("../fixtures/dependency-graph/generated", import.meta.url));

/** The id of the navigation file in the fixture site. */
const NAVIGATION = "navigation:_data/navigation.yml";

/** Builds the model, then the graph, the way the integration issue will. */
async function graphOf(root: string): Promise<DependencyGraphResult> {
  const { site } = await buildModel(root);
  return buildDependencyGraph({ root, site });
}

/** The ids of `diagnostics` with `id`, for the tests that count one kind. */
function only(diagnostics: readonly Diagnostic[], id: string): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.id === id);
}

test("the graph names every page, include, data file, the navigation file, an asset, and every output", async () => {
  const { graph, diagnostics } = await graphOf(SITE);
  assert.deepEqual(diagnostics, []);

  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.kind]),
    [
      [fileNodeId("_data/authors.yml"), "data"],
      [fileNodeId("_snippets/outer.md"), "include"],
      [fileNodeId("_snippets/shared.md"), "include"],
      [fileNodeId("alpha.md"), "page"],
      [fileNodeId("beta.md"), "page"],
      [fileNodeId("gamma.md"), "page"],
      [fileNodeId("media/logo.svg"), "asset"],
      [fileNodeId("mizzen.yml"), "asset"],
      [NAVIGATION, "navigation"],
      [outputNodeId("/alpha/"), "output"],
      [outputNodeId("/beta/"), "output"],
      [outputNodeId("/gamma/"), "output"],
    ],
  );
});

test("edges point from the dependent to what it needs, including nested includes and the front matter image", async () => {
  const { graph } = await graphOf(SITE);
  const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);

  assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("_snippets/outer.md")}`));
  assert.ok(pairs.includes(`${fileNodeId("_snippets/outer.md")} -> ${fileNodeId("_snippets/shared.md")}`));
  assert.ok(pairs.includes(`${fileNodeId("beta.md")} -> ${fileNodeId("_snippets/shared.md")}`));
  assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("media/logo.svg")}`));
  for (const url of ["/alpha/", "/beta/", "/gamma/"]) {
    assert.ok(pairs.includes(`${outputNodeId(url)} -> ${NAVIGATION}`));
    assert.ok(pairs.includes(`${outputNodeId(url)} -> ${fileNodeId("_data/authors.yml")}`));
  }

  // The include's position is the directive line, so a cycle or miss points at the file to edit.
  const alphaToOuter = graph.edges.find((edge) => edge.to === fileNodeId("_snippets/outer.md") && edge.from === fileNodeId("alpha.md"));
  assert.equal(alphaToOuter?.pos?.file, "alpha.md");
  assert.equal(alphaToOuter?.pos?.line, 5);
});

test("a changed include affects every page that includes it, transitively, and no unrelated page", async () => {
  const { graph } = await graphOf(SITE);
  assert.deepEqual(affectedNodes(graph, ["_snippets/shared.md"]), [
    fileNodeId("_snippets/outer.md"),
    fileNodeId("alpha.md"),
    fileNodeId("beta.md"),
    outputNodeId("/alpha/"),
    outputNodeId("/beta/"),
  ]);
});

test("a changed page affects only its own output when a navigation file exists", async () => {
  const { graph } = await graphOf(SITE);
  assert.deepEqual(affectedNodes(graph, ["gamma.md"]), [outputNodeId("/gamma/")]);
  assert.deepEqual(affectedNodes(graph, [fileNodeId("gamma.md")]), [outputNodeId("/gamma/")]);
});

test("a changed nav file or data file affects every output, and a changed asset affects its page", async () => {
  const { graph } = await graphOf(SITE);
  const everyOutput = [outputNodeId("/alpha/"), outputNodeId("/beta/"), outputNodeId("/gamma/")];
  assert.deepEqual(affectedNodes(graph, ["_data/navigation.yml"]), everyOutput);
  assert.deepEqual(affectedNodes(graph, ["_data/authors.yml"]), everyOutput);
  assert.deepEqual(affectedNodes(graph, ["media/logo.svg"]), [fileNodeId("alpha.md"), outputNodeId("/alpha/")]);
});

test("a node that no dependency names has no affected set", async () => {
  const { graph } = await graphOf(SITE);
  assert.deepEqual(affectedNodes(graph, ["does-not-exist.md"]), []);
});

test("navigation built from folders is a derived node that reads every page", async () => {
  const { graph } = await graphOf(GENERATED);
  const navigation = graph.nodes.find((node) => node.kind === "navigation");
  assert.deepEqual(navigation, { id: "navigation:generated", kind: "navigation", path: "_data/navigation.yml", derived: true });

  assert.deepEqual(affectedNodes(graph, ["alpha.md"]), [
    "navigation:generated",
    outputNodeId("/"),
    outputNodeId("/alpha/"),
  ]);
  assert.deepEqual(affectedNodes(graph, ["navigation:generated"]), [outputNodeId("/"), outputNodeId("/alpha/")]);
});

test("a missing dependency is an error at the directive line, and its node still finds the dependents", async () => {
  const { graph, diagnostics } = await graphOf(BROKEN);
  const missing = only(diagnostics, "dependency.missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.severity, "error");
  assert.match(missing[0]!.message, /nope\.md/);
  assert.match(missing[0]!.help ?? "", /nope\.md/);
  assert.equal(missing[0]!.pos?.file, "missing.md");
  assert.equal(missing[0]!.pos?.line, 5);

  const node = graph.nodes.find((candidate) => candidate.path === "nope.md");
  assert.equal(node?.missing, true);
  assert.deepEqual(affectedNodes(graph, ["nope.md"]), [fileNodeId("missing.md"), outputNodeId("/missing/")]);
});

test("an include cycle is one error with the whole chain at the edge that closes it", async () => {
  const { diagnostics } = await graphOf(BROKEN);
  const cycles = only(diagnostics, "dependency.cycle");
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]!.severity, "error");
  assert.match(cycles[0]!.message, /a\.md → b\.md → a\.md/);
  assert.match(cycles[0]!.help ?? "", /a\.md/);
  assert.equal(cycles[0]!.pos?.file, "b.md");
  assert.equal(cycles[0]!.pos?.line, 4);
});

test("serialization does not depend on discovery or insertion order", async () => {
  const { site } = await buildModel(SITE);
  const files = await discover(SITE);
  const forward = await buildDependencyGraph({ root: SITE, site, files });
  const backward = await buildDependencyGraph({ root: SITE, site, files: [...files].reverse() });
  const again = await buildDependencyGraph({ root: SITE, site });

  assert.equal(serializeDependencyGraph(forward.graph), serializeDependencyGraph(backward.graph));
  assert.equal(serializeDependencyGraph(forward.graph), serializeDependencyGraph(again.graph));
  assert.equal(serializeDependencyGraph(forward.graph).endsWith("\n"), true);

  const ids = forward.graph.nodes.map((node) => node.id);
  assert.deepEqual(ids, [...ids].sort());
  const edges = forward.graph.edges.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.pos?.line ?? 0}`);
  assert.deepEqual(edges, [...edges].sort());
});
