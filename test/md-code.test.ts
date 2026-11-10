import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Code, Nodes, Root } from "mdast";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { codeMetaOf, parseCodeMeta, type CodeGroup, type CodeMeta, type LineRange } from "../src/markdown/plugins/code.ts";

/** The fixture site the issue's done-when names. */
const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/docs-site/", import.meta.url));

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function codesIn(tree: Root): Code[] {
  const found: Code[] = [];
  visit(tree, (n) => {
    if (n.type === "code") found.push(n);
  });
  return found;
}

/**
 * Every fence in a page, including the fences inside a `tabs` block: that block's body is Markdown
 * for the tabs component, so its meta forms are part of what the fixture site must parse.
 */
async function fencesIncludingTabs(tree: Root): Promise<Code[]> {
  const found: Code[] = [];
  for (const node of codesIn(tree)) {
    found.push(node);
    if (node.lang === "tabs") found.push(...(await fencesIncludingTabs(await parseMarkdown(node.value))));
  }
  return found;
}

function groupsIn(tree: Root): CodeGroup[] {
  const found: CodeGroup[] = [];
  visit(tree, (n) => {
    if (n.type === "codeGroup") found.push(n as CodeGroup);
  });
  return found;
}

/** Every `.md` file under the fixture site, relative to its root. */
function fixturePages(): string[] {
  return readdirSync(FIXTURES_ROOT, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".md"));
}

async function parsePage(file: string): Promise<Root> {
  const source = readFileSync(join(FIXTURES_ROOT, file), "utf8");
  const { body, bodyLine } = parseFrontMatter(source, file);
  return parseMarkdown(body, bodyLine);
}

const range = (from: number, to = from): LineRange => ({ from, to });

test("code is discovered after GFM", async () => {
  const plugins = await loadMarkdownPlugins();
  const code = plugins.find((p) => p.name === "code");
  assert.ok(code, "the code plugin is discovered from the plugins folder");
  assert.equal(code?.order, 10);
  assert.equal(plugins[0]?.name, "gfm");
});

test("every meta form in fixtures/docs-site parses, and each fence keeps its raw meta", async () => {
  const seen = new Map<string, Code>();
  for (const file of fixturePages()) {
    for (const node of await fencesIncludingTabs(await parsePage(file))) {
      if (!node.meta) continue;
      const meta = codeMetaOf(node);
      assert.ok(meta, `${file}: fence with meta "${node.meta}" has data.code`);
      assert.equal(meta.raw, node.meta, `${file}: raw meta is kept verbatim`);
      seen.set(node.meta, node);
    }
  }
  assert.ok(seen.size >= 5, "the fixture site has the meta forms this test pins");

  const expected: Record<string, Partial<CodeMeta>> = {
    'title="beacon.config.js" {2,4-5}': { title: "beacon.config.js", highlight: [range(2), range(4, 5)] },
    'title="beacon.yml"': { title: "beacon.yml" },
    'title="npm"': { title: "npm" },
    'title="Homebrew"': { title: "Homebrew" },
    'title="Go"': { title: "Go" },
  };
  for (const [meta, want] of Object.entries(expected)) {
    const node = seen.get(meta);
    assert.ok(node, `fixture has a fence with meta ${meta}`);
    const got = codeMetaOf(node);
    for (const key of Object.keys(want) as (keyof CodeMeta)[]) {
      assert.deepEqual(got?.[key], want[key], `${meta}: ${key}`);
    }
  }
});

test("title, bare line marks, ins, del, and showLineNumbers parse from one fence", async () => {
  const tree = await parseMarkdown('```ts title="a.ts" {1,3-5} ins={2} del={4} showLineNumbers\nconst a = 1;\n```\n');
  const [node] = codesIn(tree);
  assert.ok(node);
  assert.equal(node.lang, "ts");
  assert.deepEqual(codeMetaOf(node), {
    raw: 'title="a.ts" {1,3-5} ins={2} del={4} showLineNumbers',
    title: "a.ts",
    highlight: [range(1), range(3, 5)],
    ins: [range(2)],
    del: [range(4)],
    diff: false,
    showLineNumbers: true,
  });
});

test("a bare diff token turns diff mode on and leaves the other fields empty", async () => {
  const tree = await parseMarkdown('```diff title="config.yml" {2,4-6} diff\n-a\n+b\n```\n');
  const [node] = codesIn(tree);
  assert.ok(node);
  assert.deepEqual(codeMetaOf(node), {
    raw: 'title="config.yml" {2,4-6} diff',
    title: "config.yml",
    highlight: [range(2), range(4, 6)],
    ins: [],
    del: [],
    diff: true,
    showLineNumbers: false,
  });
});

test("diff is only the bare token: a title or a key named diff does not turn it on", () => {
  assert.equal(parseCodeMeta("diff").diff, true);
  assert.equal(parseCodeMeta('title="diff"').diff, false);
  assert.equal(parseCodeMeta("diff=false").diff, false);
});

test("a fence with no meta gets empty fields, not missing ones", async () => {
  const [node] = codesIn(await parseMarkdown("```bash\nnpm ci\n```\n"));
  assert.ok(node);
  assert.deepEqual(codeMetaOf(node), {
    raw: "",
    title: null,
    highlight: [],
    ins: [],
    del: [],
    diff: false,
    showLineNumbers: false,
  });
});

test("quotes are optional, single quotes work, and an empty title is no title", () => {
  assert.equal(parseCodeMeta("title=a.ts").title, "a.ts");
  assert.equal(parseCodeMeta("title='b c.ts'").title, "b c.ts");
  assert.equal(parseCodeMeta('title=""').title, null);
});

test("line lists skip what does not parse and keep what does", () => {
  const meta = parseCodeMeta("{0,x,5-3,2,7-9} del={-1} ins=\"3\"");
  assert.deepEqual(meta.highlight, [range(2), range(7, 9)]);
  assert.deepEqual(meta.del, []);
  assert.deepEqual(meta.ins, [range(3)]);
});

test("showLineNumbers is off by default and off when set to false", () => {
  assert.equal(parseCodeMeta("").showLineNumbers, false);
  assert.equal(parseCodeMeta("showLineNumbers").showLineNumbers, true);
  assert.equal(parseCodeMeta("showLineNumbers=false").showLineNumbers, false);
  assert.equal(parseCodeMeta("showLineNumbers={true}").showLineNumbers, true);
});

test("the code node's value is untouched: nothing is highlighted here", async () => {
  const [node] = codesIn(await parseMarkdown('```ts title="a.ts" {1}\nconst a = 1;\n```\n'));
  assert.equal(node?.value, "const a = 1;");
  assert.equal((node?.data as Record<string, unknown>).hProperties, undefined);
});

test("adjacent fences inside :::code-group become one group with tab labels from titles", async () => {
  const tree = await parseMarkdown(
    [
      ":::code-group",
      "",
      '```bash title="npm"',
      "npm ci",
      "```",
      "",
      '```bash title="Go"',
      "go build",
      "```",
      "",
      "```yaml",
      "a: 1",
      "```",
      ":::",
      "",
      "after",
      "",
    ].join("\n"),
  );
  assert.equal(tree.children.length, 2, "the group and the paragraph after it");
  const [group] = groupsIn(tree);
  assert.ok(group);
  assert.deepEqual(group.data?.codeGroup, { labels: ["npm", "Go", "yaml"] }, "the third tab falls back to its language");
  assert.deepEqual(
    group.children.map((c) => c.value),
    ["npm ci", "go build", "a: 1"],
  );
  assert.equal(group.position?.start.line, 1, "the group starts at the opening marker");
  assert.equal(group.position?.end.line, 14, "and ends at the closing marker");
  assert.equal(tree.children[1]?.type, "paragraph");
});

test("a fence with neither title nor language is labelled by its position", async () => {
  const tree = await parseMarkdown(":::code-group\n```\none\n```\n```\ntwo\n```\n:::\n");
  assert.deepEqual(groupsIn(tree)[0]?.data?.codeGroup, { labels: ["1", "2"] });
});

test("a group with text between its fences is not a group: the markers stay as text", async () => {
  const tree = await parseMarkdown(":::code-group\n```bash\none\n```\n\nNot a fence.\n\n```bash\ntwo\n```\n:::\n");
  assert.equal(groupsIn(tree).length, 0);
  assert.ok(tree.children.some((n) => n.type === "paragraph"));
});

test("an opening marker with no closing marker is left as text", async () => {
  const tree = await parseMarkdown(":::code-group\n```bash\none\n```\n");
  assert.equal(groupsIn(tree).length, 0);
});

test("a group inside a list item is found too", async () => {
  const tree = await parseMarkdown("- item\n\n  :::code-group\n  ```bash\n  one\n  ```\n  :::\n");
  assert.equal(groupsIn(tree).length, 1);
});
