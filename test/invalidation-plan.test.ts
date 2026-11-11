import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/content/discover.ts";
import { buildModel } from "../src/model/build.ts";
import {
  buildDependencyGraph,
  fileNodeId,
  outputNodeId,
  type DependencyGraph,
  type DependencyGraphResult,
} from "../src/pipeline/dependency-graph.ts";
import {
  planInvalidation,
  serializeInvalidationPlan,
  type InvalidationPlan,
  type PlannedOutput,
} from "../src/pipeline/invalidation.ts";

const SITE = fileURLToPath(new URL("../fixtures/invalidation-plan/site", import.meta.url));
const GENERATED = fileURLToPath(new URL("../fixtures/dependency-graph/generated", import.meta.url));
const BROKEN = fileURLToPath(new URL("../fixtures/dependency-graph/broken", import.meta.url));

const NAVIGATION = "navigation:_data/navigation.yml";

/** Builds the model, then the graph, the way the integration issue will. */
async function graphOf(root: string): Promise<DependencyGraphResult> {
  const { site } = await buildModel(root);
  return buildDependencyGraph({ root, site });
}

/** Plans a narrow or complete rebuild over one graph. */
function planOf(
  graph: DependencyGraph,
  changes: Parameters<typeof planInvalidation>[0]["changes"] = [],
  global: Parameters<typeof planInvalidation>[0]["global"] = [],
): InvalidationPlan {
  return planInvalidation({ graph, changes, global });
}

/** The output ids of a plan, in plan order. */
function outputsOf(plan: InvalidationPlan): string[] {
  return plan.outputs.map((output) => output.id);
}

/** One output by URL, which must be present. */
function outputAt(plan: InvalidationPlan, url: string): PlannedOutput {
  const output = plan.outputs.find((candidate) => candidate.url === url);
  assert.ok(output !== undefined, `expected an output at ${url}`);
  return output;
}

/** The cause node ids an output carries, direct first and transitive second. */
function causeNodes(output: PlannedOutput): string[] {
  return [...output.direct, ...output.transitive].map((cause) => cause.node);
}

/** Checks the shape every cause must have: a chain that starts at its output and ends at the input it names. */
function assertChains(output: PlannedOutput): void {
  assert.ok(output.direct.length + output.transitive.length > 0, `${output.url} has no cause`);
  for (const cause of [...output.direct, ...output.transitive]) {
    assert.equal(cause.chain[0]!.id, output.id);
    assert.equal(cause.chain.at(-1)!.id, cause.node);
    assert.ok(cause.explanation.includes("→"));
    assert.ok(cause.explanation.includes(`(${cause.kind})`));
    assert.equal(cause.chain.map((step) => step.path).join(" → "), cause.explanation.slice(0, -(cause.kind.length + 3)));
  }
}

test("the graph tracks front-matter images, body images, and images inside includes", async () => {
  const { graph, diagnostics } = await graphOf(SITE);
  const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);

  assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("media/logo.svg")}`));
  assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("media/body.svg")}`));
  assert.ok(pairs.includes(`${fileNodeId("beta.md")} -> ${fileNodeId("media/body.svg")}`));
  assert.ok(pairs.includes(`${fileNodeId("_snippets/shared.md")} -> ${fileNodeId("media/snippet.svg")}`));

  // A missing image is an error on the page that names it, and the missing node still has its dependent.
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.id === "dependency.missing").length, 1);
  const missing = graph.nodes.find((node) => node.path === "media/gone.png");
  assert.equal(missing?.missing, true);
  assert.ok(pairs.includes(`${fileNodeId("missing.md")} -> ${fileNodeId("media/gone.png")}`));
});

test("a changed include is transitive and reaches only the pages that include it", async () => {
  const { graph } = await graphOf(SITE);
  const plan = planOf(graph, [{ kind: "changed", path: "_snippets/shared.md" }]);

  assert.equal(plan.complete, false);
  assert.deepEqual(plan.reasons, []);
  assert.deepEqual(outputsOf(plan), [outputNodeId("/alpha/"), outputNodeId("/beta/")]);

  const alpha = outputAt(plan, "/alpha/");
  assert.deepEqual(alpha.direct, []);
  assert.equal(alpha.transitive.length, 1);
  assert.equal(alpha.transitive[0]!.kind, "changed");
  assert.equal(alpha.transitive[0]!.node, fileNodeId("_snippets/shared.md"));
  assert.deepEqual(alpha.transitive[0]!.chain.map((step) => step.path), [
    "/alpha/",
    "alpha.md",
    "_snippets/outer.md",
    "_snippets/shared.md",
  ]);
  assert.equal(alpha.transitive[0]!.explanation, "/alpha/ → alpha.md → _snippets/outer.md → _snippets/shared.md (changed)");

  const beta = outputAt(plan, "/beta/");
  assert.deepEqual(beta.transitive[0]!.chain.map((step) => step.path), ["/beta/", "beta.md", "_snippets/shared.md"]);
  for (const output of plan.outputs) assertChains(output);
});

test("a changed page is a direct cause, and a changed body asset is transitive", async () => {
  const { graph } = await graphOf(SITE);

  const page = planOf(graph, [{ kind: "changed", path: "alpha.md" }]);
  assert.deepEqual(outputsOf(page), [outputNodeId("/alpha/")]);
  const alpha = outputAt(page, "/alpha/");
  assert.equal(alpha.direct.length, 1);
  assert.equal(alpha.direct[0]!.node, fileNodeId("alpha.md"));
  assert.deepEqual(alpha.direct[0]!.chain.map((step) => step.path), ["/alpha/", "alpha.md"]);
  assert.deepEqual(alpha.transitive, []);

  const body = planOf(graph, [{ kind: "changed", path: "media/body.svg" }]);
  assert.deepEqual(outputsOf(body), [outputNodeId("/alpha/"), outputNodeId("/beta/")]);
  for (const output of body.outputs) {
    assert.deepEqual(output.direct, []);
    assert.equal(output.transitive[0]!.node, fileNodeId("media/body.svg"));
    assert.equal(output.transitive[0]!.chain.length, 3);
  }

  const snippetImage = planOf(graph, [{ kind: "changed", path: "media/snippet.svg" }]);
  assert.deepEqual(outputsOf(snippetImage), [outputNodeId("/alpha/"), outputNodeId("/beta/")]);
  assert.deepEqual(outputAt(snippetImage, "/alpha/").transitive[0]!.chain.map((step) => step.path), [
    "/alpha/",
    "alpha.md",
    "_snippets/outer.md",
    "_snippets/shared.md",
    "media/snippet.svg",
  ]);

  const frontMatter = planOf(graph, [{ kind: "changed", path: "media/logo.svg" }]);
  assert.deepEqual(outputsOf(frontMatter), [outputNodeId("/alpha/")]);
});

test("navigation and data are direct causes of every output", async () => {
  const { graph } = await graphOf(SITE);
  const every = [outputNodeId("/alpha/"), outputNodeId("/beta/"), outputNodeId("/gamma/"), outputNodeId("/missing/")];

  const data = planOf(graph, [{ kind: "changed", path: "_data/authors.yml" }]);
  assert.deepEqual(outputsOf(data), every);
  for (const output of data.outputs) {
    assert.equal(output.direct[0]!.node, fileNodeId("_data/authors.yml"));
    assert.deepEqual(output.transitive, []);
  }

  const navigation = planOf(graph, [{ kind: "changed", path: "_data/navigation.yml" }]);
  assert.deepEqual(outputsOf(navigation), every);
  for (const output of navigation.outputs) assert.equal(output.direct[0]!.node, NAVIGATION);

  const missingImage = planOf(graph, [{ kind: "changed", path: "media/gone.png" }]);
  assert.deepEqual(outputsOf(missingImage), [outputNodeId("/missing/")]);
  assert.equal(outputAt(missingImage, "/missing/").transitive[0]!.node, fileNodeId("media/gone.png"));
});

test("generated navigation is a node between a page change and every output", async () => {
  const { graph } = await graphOf(GENERATED);

  const page = planOf(graph, [{ kind: "changed", path: "alpha.md" }]);
  assert.deepEqual(outputsOf(page), [outputNodeId("/"), outputNodeId("/alpha/")]);
  assert.equal(outputAt(page, "/alpha/").direct[0]!.node, fileNodeId("alpha.md"));
  assert.deepEqual(outputAt(page, "/alpha/").transitive, []);
  assert.deepEqual(outputAt(page, "/").transitive[0]!.chain.map((step) => step.path), [
    "/",
    "_data/navigation.yml",
    "alpha.md",
  ]);
  assert.equal(outputAt(page, "/").direct.length, 0);

  const generated = planOf(graph, [{ kind: "changed", path: "navigation:generated" }]);
  assert.deepEqual(outputsOf(generated), [outputNodeId("/"), outputNodeId("/alpha/")]);
  for (const output of generated.outputs) assert.equal(output.direct[0]!.node, "navigation:generated");
});

test("deleting a page deletes its output and rebuilds the outputs that read the page set", async () => {
  const { graph } = await graphOf(SITE);
  const plan = planOf(graph, [{ kind: "deleted", path: "gamma.md" }]);

  assert.equal(plan.complete, false);
  assert.deepEqual(outputsOf(plan), [outputNodeId("/gamma/")]);
  const gamma = outputAt(plan, "/gamma/");
  assert.equal(gamma.action, "delete");
  assert.equal(gamma.direct[0]!.kind, "deleted");
  assert.equal(gamma.direct[0]!.node, fileNodeId("gamma.md"));

  const generated = await graphOf(GENERATED);
  const home = planOf(generated.graph, [{ kind: "deleted", path: "alpha.md" }]);
  assert.equal(outputAt(home, "/alpha/").action, "delete");
  assert.equal(outputAt(home, "/").action, "rebuild");
  assert.deepEqual(outputAt(home, "/").transitive[0]!.chain.map((step) => step.id), [
    outputNodeId("/"),
    "navigation:generated",
    fileNodeId("alpha.md"),
  ]);
});

test("deleting an include, an asset, the navigation file, or a data file rebuilds its dependents", async () => {
  const { graph } = await graphOf(SITE);

  const include = planOf(graph, [{ kind: "deleted", path: "_snippets/shared.md" }]);
  assert.deepEqual(outputsOf(include), [outputNodeId("/alpha/"), outputNodeId("/beta/")]);
  for (const output of include.outputs) assert.equal(output.action, "rebuild");

  const asset = planOf(graph, [{ kind: "deleted", path: "media/logo.svg" }]);
  assert.deepEqual(outputsOf(asset), [outputNodeId("/alpha/")]);

  const navigation = planOf(graph, [{ kind: "deleted", path: "_data/navigation.yml" }]);
  assert.equal(navigation.outputs.length, 4);

  const data = planOf(graph, [{ kind: "deleted", path: "_data/authors.yml" }]);
  assert.equal(data.outputs.length, 4);
});

test("a rename is a complete plan that deletes the old output and names the reason", async () => {
  const { graph } = await graphOf(SITE);
  const plan = planOf(graph, [{ kind: "renamed", from: "alpha.md", to: "renamed.md" }]);

  assert.equal(plan.complete, true);
  assert.deepEqual(plan.reasons, [
    {
      kind: "renamed",
      detail: '"alpha.md" was renamed to "renamed.md"; the graph has no node for the new path.',
    },
  ]);
  assert.deepEqual(plan.changes, [{ kind: "renamed", path: "renamed.md", from: "alpha.md" }]);
  assert.equal(plan.outputs.length, 4);
  assert.equal(outputAt(plan, "/alpha/").action, "delete");
  assert.equal(outputAt(plan, "/beta/").action, "rebuild");
  for (const output of plan.outputs) assertChains(output);
});

test("unknown globals make a complete plan with one actionable reason each", async () => {
  const { graph } = await graphOf(SITE);
  const plan = planOf(graph, [], ["plugin", "theme", "theme", "output", "runtime", "unknown"]);

  assert.equal(plan.complete, true);
  assert.deepEqual(plan.reasons.map((reason) => reason.kind), ["output", "plugin", "runtime", "theme", "unknown"]);
  assert.equal(plan.outputs.length, 4);
  for (const output of plan.outputs) {
    assert.deepEqual(output.direct, []);
    assert.deepEqual(
      output.transitive.map((cause) => cause.node),
      ["global:output", "global:plugin", "global:runtime", "global:theme", "global:unknown"],
    );
    assertChains(output);
  }
});

test("a change with no node in the graph is a full-build reason, not a guess", async () => {
  const { graph } = await graphOf(SITE);
  const plan = planOf(graph, [{ kind: "changed", path: "new-page.md" }]);

  assert.equal(plan.complete, true);
  assert.deepEqual(plan.reasons, [
    { kind: "unknown", detail: 'The change to "new-page.md" has no node in the dependency graph.' },
  ]);
  assert.deepEqual(plan.changes, [{ kind: "changed", path: "new-page.md" }]);
  assert.equal(plan.outputs.length, 4);
  for (const output of plan.outputs) assert.equal(output.transitive[0]!.node, "unknown:new-page.md");
});

test("cycles and duplicate edges produce one plan with no duplicates and terminate", async () => {
  const { graph } = await graphOf(BROKEN);
  const once = planOf(graph, [
    { kind: "changed", path: "a.md" },
    { kind: "changed", path: "a.md" },
    { kind: "changed", path: "b.md" },
  ]);

  assert.equal(once.complete, false);
  assert.equal(new Set(outputsOf(once)).size, once.outputs.length);
  assert.equal(once.changes.length, 2);
  const a = outputAt(once, "/a/");
  const b = outputAt(once, "/b/");
  assert.deepEqual(a.direct.map((cause) => cause.node), [fileNodeId("a.md")]);
  assert.deepEqual(a.transitive.map((cause) => cause.node), [fileNodeId("b.md")]);
  assert.deepEqual(a.transitive[0]!.chain.map((step) => step.id), [
    outputNodeId("/a/"),
    fileNodeId("a.md"),
    fileNodeId("b.md"),
  ]);
  assert.equal(b.direct[0]!.node, fileNodeId("b.md"));
  assert.equal(b.transitive[0]!.node, fileNodeId("a.md"));

  const duplicated: DependencyGraph = {
    nodes: graph.nodes,
    edges: [...graph.edges, ...graph.edges],
  };
  const shuffled: DependencyGraph = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
  const expected = serializeInvalidationPlan(once);
  assert.equal(serializeInvalidationPlan(planOf(duplicated, [{ kind: "changed", path: "a.md" }, { kind: "changed", path: "b.md" }])), expected);
  assert.equal(serializeInvalidationPlan(planOf(shuffled, [{ kind: "changed", path: "b.md" }, { kind: "changed", path: "a.md" }])), expected);
});

test("two equivalent graphs and change sets serialize byte for byte, whatever the insertion order", async () => {
  const { site } = await buildModel(SITE);
  const files = await discover(SITE);
  const forward = await buildDependencyGraph({ root: SITE, site, files });
  const backward = await buildDependencyGraph({ root: SITE, site, files: [...files].reverse() });

  const changes = [
    { kind: "changed" as const, path: "_snippets/shared.md" },
    { kind: "deleted" as const, path: "gamma.md" },
  ];
  const globals = ["theme", "plugin"] as const;
  const a = planOf(forward.graph, changes, [...globals]);
  const b = planOf(backward.graph, [...changes].reverse(), [...globals].reverse());

  const text = serializeInvalidationPlan(a);
  assert.equal(serializeInvalidationPlan(b), text);
  assert.equal(serializeInvalidationPlan(a), text);
  assert.equal(text.endsWith("\n"), true);
  assert.deepEqual(outputsOf(a), [...outputsOf(a)].sort());

  const parsed = JSON.parse(text) as { version: number; complete: boolean; outputs: { id: string }[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.outputs.map((output) => output.id), outputsOf(a));
});
