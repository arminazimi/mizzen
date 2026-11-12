/**
 * Issue #107: a dependency reference whose URL is percent-encoded must name the same asset the built URL names,
 * so the graph connects the reference to the file discovery found instead of inventing a missing node.
 *
 * The sites here are built in a temp folder, because the point of the issue is file names with spaces, non-ASCII
 * characters and reserved punctuation in them.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { discover } from "../src/content/discover.ts";
import { buildModel } from "../src/model/build.ts";
import {
  affectedNodes,
  buildDependencyGraph,
  fileNodeId,
  outputNodeId,
  serializeDependencyGraph,
  type DependencyGraph,
  type DependencyGraphResult,
  type DependencyNode,
} from "../src/pipeline/dependency-graph.ts";

/** The media every site here holds, with the names discovery records: spaces, CJK, reserved characters, a percent sign and a question mark. */
const MEDIA: Record<string, string> = {
  "media/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n",
  "media/my image.png": "a png with a space\n",
  "media/媒体.png": "a png with a CJK name\n",
  "media/per+cent(1).png": "a png with reserved characters\n",
  "media/100%.png": "a png with a percent sign\n",
  "media/logo?svg": "a png with a question mark\n",
};

/** The one-page site shape: a navigation file, so an asset change affects exactly one page and one output. */
function navFiles(): Record<string, string> {
  return {
    "mizzen.yml": "title: Encoded assets\nnavigation: _data/navigation.yml\n",
    "_data/navigation.yml": "docs:\n  - title: Index\n    url: /\n",
    ...MEDIA,
  };
}

/** Writes every entry of `files` under a fresh temp site, runs `run` in it, and removes the site afterwards. */
async function withSite<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mizzen-encoded-assets-"));
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

/** Every edge as `from -> to`, for readable membership checks. */
function pairs(graph: DependencyGraph): string[] {
  return graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
}

function edgeTo(graph: DependencyGraph, from: string, to: string): DependencyGraph["edges"][number] | undefined {
  return graph.edges.find((edge) => edge.from === from && edge.to === to);
}

/** The 1-based line of `needle` in `text`, which is what a stable span must name. */
function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `expected ${needle} in the source`);
  return text.slice(0, at).split("\n").length;
}

/** Nodes that still spell a file name with a percent escape, which the graph must never do. */
function escapedNodes(graph: DependencyGraph): DependencyNode[] {
  return graph.nodes.filter((node) => /%[\da-f]{2}/i.test(node.path));
}

const INDEX_SPANS = `---
title: Index
image: /media/my%20image.png
---
![space](media/my%20image.png)

![unicode](media/%E5%AA%92%E4%BD%93.png)

![reserved](media/per%2Bcent%281%29.png)

![percent](media/100%25.png)
`;

test("an encoded space, CJK name, reserved characters and percent sign connect to the discovered asset", async () => {
  await withSite({ ...navFiles(), "index.md": INDEX_SPANS }, async (root) => {
    const { graph, diagnostics } = await graphOf(root);

    // Nothing is missing: every reference resolved to a file discovery found.
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(graph.nodes.filter((node) => node.missing === true), []);

    const from = fileNodeId("index.md");
    for (const path of ["media/my image.png", "media/媒体.png", "media/per+cent(1).png", "media/100%.png"]) {
      assert.ok(pairs(graph).includes(`${from} -> ${fileNodeId(path)}`), `expected an edge to ${path}`);
      const node = graph.nodes.find((candidate) => candidate.id === fileNodeId(path));
      assert.equal(node?.kind, "asset");
      assert.equal(node?.missing, undefined);
    }

    // No node is spelled with an escape: the graph names files, not URLs.
    assert.deepEqual(escapedNodes(graph), []);
  });
});

test("a change to the decoded asset invalidates every page that named it in encoded form", async () => {
  await withSite({ ...navFiles(), "index.md": INDEX_SPANS }, async (root) => {
    const { graph } = await graphOf(root);
    const output = outputNodeId("/");

    assert.deepEqual(affectedNodes(graph, ["media/my image.png"]), [fileNodeId("index.md"), output].sort());
    assert.deepEqual(affectedNodes(graph, [fileNodeId("media/媒体.png")]), [fileNodeId("index.md"), output].sort());
    assert.deepEqual(affectedNodes(graph, ["media/100%.png"]), [fileNodeId("index.md"), output].sort());
    assert.deepEqual(affectedNodes(graph, ["media/missing image.png"]), []);
  });
});

test("an encoded reference keeps the source span of the text that names it", async () => {
  await withSite({ ...navFiles(), "index.md": INDEX_SPANS }, async (root) => {
    const { graph } = await graphOf(root);

    // The front matter image is at the start of the file; the body images keep their own line.
    const front = edgeTo(graph, fileNodeId("index.md"), fileNodeId("media/my image.png"));
    assert.equal(front?.pos?.line, 1);
    assert.equal(front?.pos?.column, 1);

    for (const [needle, path] of [
      ["![space](media/my%20image.png)", "media/my image.png"],
      ["![unicode](media/%E5%AA%92%E4%BD%93.png)", "media/媒体.png"],
      ["![reserved](media/per%2Bcent%281%29.png)", "media/per+cent(1).png"],
      ["![percent](media/100%25.png)", "media/100%.png"],
    ] as const) {
      const at = lineOf(INDEX_SPANS, needle);
      const edge = graph.edges.find(
        (candidate) => candidate.from === fileNodeId("index.md") && candidate.to === fileNodeId(path) && candidate.pos?.line === at,
      );
      assert.ok(edge !== undefined, `expected an edge at line ${at} for ${path}`);
      assert.equal(edge.pos?.file, "index.md");
      assert.equal(edge.pos?.column, 1);
      // The span is the encoded text as written, so the position still points at real columns.
      assert.equal(edge.pos?.endColumn, 1 + needle.length);
      assert.equal(edge.pos?.endLine, at);
    }
  });
});

test("root-relative encoded references strip the base, and query and fragment removal still happens before decoding", async () => {
  await withSite(
    {
      "mizzen.yml": "title: Encoded assets\nbase: /docs\nnavigation: _data/navigation.yml\n",
      "_data/navigation.yml": "docs:\n  - title: Index\n    url: /docs/\n",
      ...MEDIA,
      "index.md": `---
title: Index
---
![base](/docs/media/my%20image.png)

![query](/docs/media/logo.svg?v=1%202)

![fragment](/docs/media/logo.svg#top%20one)
`,
    },
    async (root) => {
      const { graph, diagnostics } = await graphOf(root);
      assert.deepEqual(diagnostics, []);
      const from = fileNodeId("index.md");
      assert.ok(pairs(graph).includes(`${from} -> ${fileNodeId("media/my image.png")}`));
      assert.ok(pairs(graph).includes(`${from} -> ${fileNodeId("media/logo.svg")}`));
      // One query, one fragment: two edges to the plain asset, and nothing else.
      assert.equal(graph.edges.filter((edge) => edge.to === fileNodeId("media/logo.svg")).length, 2);
      assert.deepEqual(graph.nodes.filter((node) => node.missing === true), []);
      assert.deepEqual(escapedNodes(graph), []);
      assert.equal(graph.nodes.filter((node) => node.path.includes("?") && node.path.includes("=")).length, 0);
      assert.equal(graph.nodes.filter((node) => node.path.includes("#")).length, 0);
    },
  );

  await withSite({ ...navFiles(), "index.md": "![root](/media/my%20image.png)\n" }, async (root) => {
    const { graph, diagnostics } = await graphOf(root);
    assert.deepEqual(diagnostics, []);
    assert.ok(pairs(graph).includes(`${fileNodeId("index.md")} -> ${fileNodeId("media/my image.png")}`));
  });
});

test("an encoded parent segment resolves like a written one and may not leave the source folder", async () => {
  await withSite(
    {
      ...navFiles(),
      "sub/page.md": `![up](../media/my%20image.png)

![dots](%2e%2e/media/logo.svg)

![out](../../outside%20secret.png)

![encoded separators](%2e%2e%2f%2e%2e%2foutside.png)

![escaped separator](media%2Fmy%20image.png)

![escaped backslash](media/%5Clogo.svg)
`,
    },
    async (root) => {
      const { graph, diagnostics } = await graphOf(root);
      const from = fileNodeId("sub/page.md");
      const found = pairs(graph);

      // Confined parent segments keep working once decoded.
      assert.ok(found.includes(`${from} -> ${fileNodeId("media/my image.png")}`));
      assert.ok(found.includes(`${from} -> ${fileNodeId("media/logo.svg")}`));

      // An escape may not become a separator, and no reference may leave the source folder, so the escaping
      // and escaping references name nothing at all: no missing node, no misleading edge.
      assert.deepEqual(graph.nodes.filter((node) => node.missing === true), []);
      assert.deepEqual(diagnostics, []);
      assert.equal(graph.nodes.filter((node) => node.path.includes("outside")).length, 0);
      assert.deepEqual(escapedNodes(graph), []);
      assert.equal(graph.edges.filter((edge) => edge.to.includes("outside")).length, 0);
      // An escaped separator must not alias the asset its decoding would name.
      assert.equal(graph.edges.filter((edge) => edge.from === from && edge.to === fileNodeId("media/my image.png")).length, 1);
    },
  );
});

test("a malformed escape names nothing instead of guessing a file", async () => {
  await withSite(
    {
      ...navFiles(),
      "index.md": `![broken](media/broken%2.png)

![bad hex](media/%zz.png)

![short utf8](media/%E4%BD.png)

![lone percent](media/lone%.png)

![separator](media/%2Flogo.svg)

![backslash](media/%5Clogo.svg)
`,
    },
    async (root) => {
      const { graph, diagnostics } = await graphOf(root);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(graph.nodes.filter((node) => node.missing === true), []);
      assert.deepEqual(graph.edges.filter((edge) => edge.from === fileNodeId("index.md")).length, 0);
      assert.deepEqual(escapedNodes(graph), []);
    },
  );
});

test("plain, external, protocol-relative, mailto, fragment-only and reference-style behaviour is unchanged", async () => {
  await withSite(
    {
      ...navFiles(),
      "index.md": `![plain](media/logo.svg)

![external](https://example.com/media/my%20image.png)

![protocol](//cdn.example.com/media/my%20image.png)

![mail](mailto:someone@example.com)

![fragment only](#top)

![ref][enc]

[enc]: /media/per%2Bcent%281%29.png
`,
    },
    async (root) => {
      const { graph, diagnostics } = await graphOf(root);
      assert.deepEqual(diagnostics, []);
      const from = fileNodeId("index.md");
      const found = pairs(graph);

      assert.ok(found.includes(`${from} -> ${fileNodeId("media/logo.svg")}`));
      assert.ok(found.includes(`${from} -> ${fileNodeId("media/per+cent(1).png")}`));
      assert.equal(
        graph.nodes.find((node) => node.path.includes("example.com") || node.path.includes("cdn") || node.path.includes("mailto")),
        undefined,
      );
      assert.deepEqual(graph.nodes.filter((node) => node.missing === true), []);
      // The reference-style image points at the definition's target but spans the reference.
      const reference = graph.edges.find((edge) => edge.to === fileNodeId("media/per+cent(1).png"));
      assert.equal(reference?.pos?.file, "index.md");
      assert.equal(reference?.pos?.line, lineOf(`![plain](media/logo.svg)

![external](https://example.com/media/my%20image.png)

![protocol](//cdn.example.com/media/my%20image.png)

![mail](mailto:someone@example.com)

![fragment only](#top)

![ref][enc]

[enc]: /media/per%2Bcent%281%29.png
`, "![ref][enc]"));
    },
  );
});

test("a question mark that is written as an escape stays part of the file name", async () => {
  await withSite({ ...navFiles(), "index.md": "![name](media/logo%3Fsvg)\n" }, async (root) => {
    const { graph, diagnostics } = await graphOf(root);
    assert.deepEqual(diagnostics, []);
    assert.ok(pairs(graph).includes(`${fileNodeId("index.md")} -> ${fileNodeId("media/logo?svg")}`));
  });
});

test("an encoded image inside a nested include belongs to the snippet and invalidates every page above it", async () => {
  await withSite(
    {
      ...navFiles(),
      "index.md": `---
title: Index
---
::include[_snippets/outer.md]
`,
      "_snippets/outer.md": "::include[deep.md]\n",
      "_snippets/deep.md": "![deep](../media/%E5%AA%92%E4%BD%93.png)\n",
    },
    async (root) => {
      const { graph, diagnostics } = await graphOf(root);
      assert.deepEqual(diagnostics, []);
      const found = pairs(graph);
      assert.ok(found.includes(`${fileNodeId("index.md")} -> ${fileNodeId("_snippets/outer.md")}`));
      assert.ok(found.includes(`${fileNodeId("_snippets/outer.md")} -> ${fileNodeId("_snippets/deep.md")}`));
      assert.ok(found.includes(`${fileNodeId("_snippets/deep.md")} -> ${fileNodeId("media/媒体.png")}`));

      const edge = graph.edges.find((candidate) => candidate.to === fileNodeId("media/媒体.png"));
      assert.equal(edge?.pos?.file, "_snippets/deep.md");
      assert.equal(edge?.pos?.line, 1);

      assert.deepEqual(
        affectedNodes(graph, ["media/媒体.png"]),
        [
          fileNodeId("_snippets/deep.md"),
          fileNodeId("_snippets/outer.md"),
          fileNodeId("index.md"),
          outputNodeId("/"),
        ].sort(),
      );
    },
  );
});

test("serialization stays deterministic with decoded names", async () => {
  await withSite({ ...navFiles(), "index.md": INDEX_SPANS }, async (root) => {
    const { site } = await buildModel(root);
    const files = await discover(root);
    const forward = await buildDependencyGraph({ root, site, files });
    const backward = await buildDependencyGraph({ root, site, files: [...files].reverse() });
    const again = await buildDependencyGraph({ root, site });

    assert.equal(serializeDependencyGraph(forward.graph), serializeDependencyGraph(backward.graph));
    assert.equal(serializeDependencyGraph(forward.graph), serializeDependencyGraph(again.graph));
    const ids = forward.graph.nodes.map((node) => node.id);
    assert.deepEqual(ids, [...ids].sort());
  });
});
