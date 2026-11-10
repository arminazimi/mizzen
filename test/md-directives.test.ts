import assert from "node:assert/strict";
import { test } from "node:test";
import type { Blockquote, Nodes, Root } from "mdast";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";

/** A parsed `sl-component` the render step will read: its name, JSON props, and data-src. */
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

/** Every element the directives unit turned into `<sl-component>`, in document order. */
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

function onlyComponent(components: Component[]): Component {
  assert.equal(components.length, 1, "exactly one sl-component");
  return components[0]!;
}

function textOf(node: Nodes): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((child) => textOf(child as Nodes)).join("");
  return "";
}

test("directives is discovered after GFM, slug, and links", async () => {
  const names = (await loadMarkdownPlugins()).map((p) => p.name);
  assert.ok(names.includes("directives"), "the directives plugin is discovered");
  assert.ok(names.indexOf("directives") > names.indexOf("links"));
  assert.ok(names.indexOf("directives") > names.indexOf("gfm"));
});

test("a container directive becomes sl-component with its attributes as JSON props", async () => {
  const tree = await parseMarkdown(":::callout{type=warning}\nWatch out.\n:::\n");
  const component = onlyComponent(componentsOf(tree));
  assert.equal(component.name, "callout");
  assert.deepEqual(component.props, { type: "warning" });
  assert.equal(component.node.type, "containerDirective");
  assert.equal(textOf(component.node), "Watch out.");
});

test("quoted and unquoted attribute values both reach data-props", async () => {
  const tree = await parseMarkdown(':::callout{type="tip" title="Read first" tone=soft}\nBody\n:::\n');
  assert.deepEqual(onlyComponent(componentsOf(tree)).props, { type: "tip", title: "Read first", tone: "soft" });
});

test("a leaf directive becomes sl-component with no children", async () => {
  const tree = await parseMarkdown("Before\n\n::badge{label=new}\n\nAfter\n");
  const component = onlyComponent(componentsOf(tree));
  assert.equal(component.name, "badge");
  assert.deepEqual(component.props, { label: "new" });
  assert.equal(component.node.type, "leafDirective");
  assert.deepEqual((component.node as { children: Nodes[] }).children, []);
});

test("a container keeps Markdown inside it as children, not as text", async () => {
  const tree = await parseMarkdown(":::note\n# Heading\n\n- one\n- two\n:::\n");
  const component = onlyComponent(componentsOf(tree));
  const kinds = (component.node as { children: Nodes[] }).children.map((child) => child.type);
  assert.deepEqual(kinds, ["heading", "list"]);
});

test("nested containers each become their own sl-component", async () => {
  const tree = await parseMarkdown(":::outer\n:::inner{n=1}\nx\n:::\n:::\n");
  const components = componentsOf(tree);
  assert.deepEqual(
    components.map((c) => c.name),
    ["outer", "inner"],
  );
  assert.deepEqual(components[1]?.props, { n: "1" });
});

test("a valueless attribute becomes an empty string prop", async () => {
  const tree = await parseMarkdown(":::details{open}\nx\n:::\n");
  assert.deepEqual(onlyComponent(componentsOf(tree)).props, { open: "" });
});

test("an unknown name passes through; the render step decides whether it exists", async () => {
  const tree = await parseMarkdown(":::nosuch\nx\n:::\n");
  assert.equal(onlyComponent(componentsOf(tree)).name, "nosuch");
});

test("GitHub alerts become a callout of the matching type", async () => {
  const kinds = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
  for (const kind of kinds) {
    const tree = await parseMarkdown(`> [!${kind}]\n> Useful text.\n`);
    const component = onlyComponent(componentsOf(tree));
    assert.equal(component.name, "callout", kind);
    assert.deepEqual(component.props, { type: kind.toLowerCase() }, kind);
    assert.equal(textOf(component.node), "Useful text.", kind);
  }
});

test("an alert whose marker stands alone keeps its later paragraphs and drops the marker", async () => {
  const tree = await parseMarkdown("> [!TIP]\n>\n> one\n>\n> two\n");
  const component = onlyComponent(componentsOf(tree));
  const paragraphs = (component.node as { children: Nodes[] }).children;
  assert.deepEqual(
    paragraphs.map((p) => textOf(p)),
    ["one", "two"],
  );
});

test("an alert with only its marker has no children", async () => {
  const tree = await parseMarkdown("> [!CAUTION]\n");
  assert.deepEqual((onlyComponent(componentsOf(tree)).node as { children: Nodes[] }).children, []);
});

test("a plain blockquote and a marker that is not alone on its line stay blockquotes", async () => {
  const plain = await parseMarkdown("> Just a quote.\n");
  assert.equal(componentsOf(plain).length, 0);
  assert.equal((plain.children[0] as Blockquote).type, "blockquote");

  const inline = await parseMarkdown("> [!NOTE] not an alert\n");
  assert.equal(componentsOf(inline).length, 0);
  assert.equal((inline.children[0] as Blockquote).type, "blockquote");
});

test("directive-like text inside a code fence stays code", async () => {
  const tree = await parseMarkdown("```\n:::callout\n:::\n```\n");
  assert.equal(componentsOf(tree).length, 0);
  assert.equal(tree.children[0]?.type, "code");
});

test("the component keeps its source position, offset by the body's first line", async () => {
  const tree = await parseMarkdown("One\n\n> [!NOTE]\n> Body\n", 4);
  const component = onlyComponent(componentsOf(tree));
  assert.equal(component.node.position?.start.line, 6);
  assert.equal(component.node.position?.start.column, 1);
});
