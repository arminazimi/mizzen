import assert from "node:assert/strict";
import { test } from "node:test";
import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";

/** A parsed `sl-component` the render step will read: its name, JSON props, and children. */
interface Component {
  readonly node: Nodes;
  readonly name: string;
  readonly props: Record<string, string>;
}

function everyNode(node: Nodes, found: Nodes[] = []): Nodes[] {
  found.push(node);
  if ("children" in node) {
    for (const child of node.children) everyNode(child as Nodes, found);
  }
  return found;
}

/** Every element the directive units turned into `<sl-component>`, in document order. */
function componentsOf(tree: Root): Component[] {
  const out: Component[] = [];
  for (const node of everyNode(tree)) {
    const data = node.data as { hName?: string; hProperties?: Record<string, string> } | undefined;
    if (data?.hName !== "sl-component") continue;
    const props = data.hProperties ?? {};
    out.push({
      node,
      name: props.name ?? "",
      props: JSON.parse(props["data-props"] ?? "{}") as Record<string, string>,
    });
  }
  return out;
}

function onlyComponent(tree: Root): Component {
  const components = componentsOf(tree);
  assert.equal(components.length, 1, "exactly one sl-component");
  return components[0]!;
}

function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if ("children" in node) return node.children.map((child) => textOf(child as Nodes)).join("");
  return "";
}

function childTypes(component: Component): string[] {
  return (component.node as { children: Nodes[] }).children.map((child) => child.type);
}

/**
 * The same tree without the admonition unit: every discovered plugin except `admonition`, on the
 * same parsed Markdown. Comparing this with `parseMarkdown` proves the unit leaves other content
 * alone, byte for byte.
 */
async function withoutAdmonition(body: string): Promise<Root> {
  const plugins = (await loadMarkdownPlugins()).filter((unit) => unit.name !== "admonition");
  assert.ok(plugins.length > 0, "other plugins are still discovered");
  const processor = unified().use(remarkParse);
  for (const unit of plugins) processor.use(unit.plugin);
  const frozen = processor.freeze() as unknown as {
    parse(value: string): Root;
    run(tree: Root): Promise<Root>;
  };
  return frozen.run(frozen.parse(body));
}

test("admonition is discovered at order 15, before directives", async () => {
  const plugins = await loadMarkdownPlugins();
  const unit = plugins.find((p) => p.name === "admonition");
  assert.ok(unit, "the admonition plugin is discovered");
  assert.equal(unit.order, 15);
  assert.ok(plugins.indexOf(unit) < plugins.findIndex((p) => p.name === "directives"));
});

test("note, tip, warning, and danger each become a callout of that type", async () => {
  for (const kind of ["note", "tip", "warning", "danger"]) {
    const tree = await parseMarkdown(`:::${kind}\nBody text.\n:::\n`);
    const component = onlyComponent(tree);
    assert.equal(component.name, "callout", kind);
    assert.deepEqual(component.props, { type: kind }, kind);
    assert.equal(component.node.type, "containerDirective", kind);
    assert.equal(textOf(component.node), "Body text.", kind);
  }
});

test("a [Title] label becomes the title and leaves the children", async () => {
  const tree = await parseMarkdown(":::warning[Back up first]\nRun it on a copy.\n:::\n");
  const component = onlyComponent(tree);
  assert.equal(component.name, "callout");
  assert.deepEqual(component.props, { type: "warning", title: "Back up first" });
  assert.deepEqual(childTypes(component), ["paragraph"]);
  assert.equal(textOf(component.node), "Run it on a copy.");
});

test("with no label the props carry only the type", async () => {
  const component = onlyComponent(await parseMarkdown(":::tip\nDo this.\n:::\n"));
  assert.deepEqual(component.props, { type: "tip" });
});

test("a label's inline markup is flattened into a plain title", async () => {
  const tree = await parseMarkdown(":::note[Use **npm** `ci`]\nBody\n:::\n");
  assert.equal(onlyComponent(tree).props.title, "Use npm ci");
});

test("an empty label sets no title and is still removed", async () => {
  const tree = await parseMarkdown(":::note[]\nBody\n:::\n");
  const component = onlyComponent(tree);
  assert.deepEqual(component.props, { type: "note" });
  assert.deepEqual(childTypes(component), ["paragraph"]);
});

test("other attributes are kept, and the name decides the type", async () => {
  const tree = await parseMarkdown(':::warning{type=note title="Kept" tone=soft}\nBody\n:::\n');
  assert.deepEqual(onlyComponent(tree).props, { type: "warning", title: "Kept", tone: "soft" });
});

test("the body keeps its Markdown as children, not as text", async () => {
  const tree = await parseMarkdown(":::note[Title]\n# Heading\n\n- one\n- two\n:::\n");
  const component = onlyComponent(tree);
  assert.deepEqual(childTypes(component), ["heading", "list"]);
});

test("nested admonitions each become their own callout", async () => {
  const tree = await parseMarkdown("::::note[Outer]\n:::tip\nInner\n:::\n::::\n");
  const components = componentsOf(tree);
  assert.deepEqual(
    components.map((c) => [c.name, c.props]),
    [
      ["callout", { type: "note", title: "Outer" }],
      ["callout", { type: "tip" }],
    ],
  );
});

test("an unknown directive passes through so the render step can report it", async () => {
  const tree = await parseMarkdown(":::nosuch[Label]{k=v}\nBody\n:::\n");
  const component = onlyComponent(tree);
  assert.equal(component.name, "nosuch");
  assert.deepEqual(component.props, { k: "v" });
  assert.deepEqual(childTypes(component), ["paragraph", "paragraph"]);
});

test(":::callout and :::admonition keep working unchanged", async () => {
  const callout = onlyComponent(await parseMarkdown(":::callout{type=warning}\nBody\n:::\n"));
  assert.equal(callout.name, "callout");
  assert.deepEqual(callout.props, { type: "warning" });

  const labelled = onlyComponent(await parseMarkdown(":::callout[Label]\nBody\n:::\n"));
  assert.equal(labelled.name, "callout");
  assert.deepEqual(labelled.props, {});
  assert.deepEqual(childTypes(labelled), ["paragraph", "paragraph"]);

  const named = onlyComponent(await parseMarkdown(":::admonition{type=tip}\nBody\n:::\n"));
  assert.equal(named.name, "admonition");
  assert.deepEqual(named.props, { type: "tip" });
});

test("directive-like text inside a code fence stays code", async () => {
  const tree = await parseMarkdown("```\n:::note[Title]\n:::\n```\n");
  assert.equal(componentsOf(tree).length, 0);
  assert.equal(tree.children[0]?.type, "code");
});

test("the callout keeps the container's position", async () => {
  const tree = await parseMarkdown("One\n\n:::note[Title]\nBody\n:::\n", 4);
  const component = onlyComponent(tree);
  assert.equal(component.node.position?.start.line, 6);
  assert.equal(component.node.position?.start.column, 1);
  const child = (component.node as { children: Nodes[] }).children[0];
  assert.equal(child?.position?.start.line, 7);
});

test("content without admonitions parses byte for byte as it did before the unit", async () => {
  const body = [
    "# Heading",
    "",
    "A paragraph with **strong**, *emphasis*, ~~strike~~, `code`, and https://example.com.",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- [x] done",
    "",
    ":::callout{type=warning title=\"Back up\"}",
    "Kept.",
    ":::",
    "",
    ":::callout[Label]",
    "Kept too.",
    ":::",
    "",
    ":::admonition{type=tip}",
    "Also kept.",
    ":::",
    "",
    ":::nosuch[Label]{k=v}",
    "Unknown, untouched.",
    ":::",
    "",
    "::badge{label=new}",
    "",
    "> [!NOTE]",
    "> An alert.",
    "",
    "```ts test",
    "console.log(\"hi\");",
    "```",
    "",
    "```output",
    "hi",
    "```",
    "",
    "```",
    ":::note[Not a directive]",
    "```",
    "",
  ].join("\n");
  const actual = await parseMarkdown(body);
  const expected = await withoutAdmonition(body);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});
