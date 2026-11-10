import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Definition, Link, LinkReference, Nodes, Root } from "mdast";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { permalink } from "../src/content/permalink.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { plugin, setLinksPagePath } from "../src/markdown/plugins/links.ts";
import { unified } from "unified";

/** Extension a rewritten link must not carry anymore. */
const PAGE_LINK = /\.(?:md|markdown)$/i;

/** A scheme or protocol-relative URL; the plugin never touches it, so it may keep a `.md` tail. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** The fixture site the issue's done-when names. */
const FIXTURES_ROOT = new URL("../fixtures/docs-site/", import.meta.url);

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function firstLink(tree: Root): Link {
  let found: Link | undefined;
  visit(tree, (n) => {
    if (!found && n.type === "link") found = n as Link;
  });
  assert.ok(found, "expected a link node");
  return found;
}

/** The `rel` a link's HTML attributes carry, read the way HTML generation will. */
function relOf(node: Link | LinkReference | undefined): string | undefined {
  const props = node?.data as Record<string, unknown> | undefined;
  return (props?.hProperties as { rel?: string } | undefined)?.rel;
}

function collect(tree: Root): { links: Link[]; references: LinkReference[]; definitions: Definition[] } {
  const links: Link[] = [];
  const references: LinkReference[] = [];
  const definitions: Definition[] = [];
  visit(tree, (n) => {
    if (n.type === "link") links.push(n as Link);
    if (n.type === "linkReference") references.push(n as LinkReference);
    if (n.type === "definition") definitions.push(n as Definition);
  });
  return { links, references, definitions };
}

/** Parses with the page announced to the links plugin, clearing the context afterwards. */
async function parseWithPagePath(body: string, path: string, bodyLine = 1): Promise<Root> {
  setLinksPagePath(path);
  try {
    return await parseMarkdown(body, bodyLine);
  } finally {
    setLinksPagePath(undefined);
  }
}

test("the links plugin is discovered and runs after GFM", async () => {
  const plugins = await loadMarkdownPlugins();
  const names = plugins.map((p) => p.name);
  assert.ok(names.includes("links"), `links missing from [${names.join(", ")}]`);
  assert.ok(names.indexOf("links") > names.indexOf("gfm"));
});

test("a relative .md link becomes the page URL and keeps its anchor", async () => {
  const tree = await parseWithPagePath("[Install](../install.md#step-2)", "guide/setup.md");
  const link = firstLink(tree);
  assert.equal(link.url, "/install/#step-2");
  assert.equal(relOf(link), undefined);
});

test("./index.md, README.md, and bare names collapse through the pretty-URL rules", async () => {
  const folder = firstLink(await parseWithPagePath("[rules](./index.md)", "reference/doctor.md"));
  assert.equal(folder.url, "/reference/");
  const readme = firstLink(await parseWithPagePath("[guide](guide/README.md)", "index.md"));
  assert.equal(readme.url, "/guide/");
  const bare = firstLink(await parseWithPagePath("[output](output.md)", "quickstart.md"));
  assert.equal(bare.url, "/output/");
});

test("without a page announced, .md links stay unchanged", async () => {
  const tree = await parseMarkdown("[a](./x.md#y)");
  assert.equal(firstLink(tree).url, "./x.md#y");
});

test("external links keep their URL and gain rel=external; anchors are untouched; absolute .md links resolve from the site root", async () => {
  const tree = await parseWithPagePath(
    "[site](https://example.com/a.md) [mail](mailto:hi@example.com) [same](#intro) [root](/install.md)",
    "guide/setup.md",
  );
  const { links } = collect(tree);
  assert.equal(links.length, 4);
  const [site, mail, same, root] = links;
  assert.equal(site?.url, "https://example.com/a.md");
  assert.equal(relOf(site), "external");
  assert.equal(mail?.url, "mailto:hi@example.com");
  assert.equal(relOf(mail), "external");
  assert.equal(same?.url, "#intro");
  assert.equal(relOf(same), undefined);
  assert.equal(root?.url, "/install/");
  assert.equal(relOf(root), undefined);
});

test("an existing rel gains external instead of being replaced", () => {
  // Markdown cannot write `data`, so another plugin's `rel` is exercised by running the
  // transformer on a prepared tree.
  const prepared: Root = {
    type: "root",
    children: [{
      type: "link",
      url: "https://example.com",
      title: null,
      children: [{ type: "text", value: "a" }],
      data: { hProperties: { rel: "nofollow" } } as unknown as Link["data"],
    }],
  };
  const tree = unified().use(plugin).runSync(prepared);
  assert.equal(relOf(tree.children[0] as Link), "nofollow external");
});

test("reference links rewrite through their definitions", async () => {
  const body = ["[rules][r] and [site][s].", "", "[r]: ../commands.md", "[s]: https://example.com/x.md", ""].join("\n");
  const tree = await parseWithPagePath(body, "rules/build-001.md");
  const { references, definitions } = collect(tree);
  assert.equal(definitions[0]?.url, "/commands/");
  assert.equal(relOf(references[0]), undefined);
  assert.equal(relOf(references[1]), "external");
});

/** Collects Markdown files under the fixture site, relative to its root, using `/` separators. */
function markdownFiles(dir = ""): string[] {
  const root = fileURLToPath(FIXTURES_ROOT);
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      out.push(...markdownFiles(rel));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test("every .md link in fixtures/docs-site rewrites to a URL the site serves", async () => {
  const files = markdownFiles();
  assert.ok(files.length > 500, `expected the full fixture, got ${files.length} pages`);

  // The URL table: every fixture page's URL, front matter `permalink` included.
  const pageUrls = new Set<string>();
  const sources = new Map<string, string>();
  for (const path of files) {
    const source = readFileSync(fileURLToPath(new URL(path, FIXTURES_ROOT)), "utf8");
    sources.set(path, source);
    const { data } = parseFrontMatter(source, path);
    const fm = typeof data.permalink === "string" ? data.permalink : undefined;
    pageUrls.add(permalink(path, fm === undefined ? {} : { permalink: fm }));
  }
  assert.ok(pageUrls.has("/404.html"), "404 keeps its front matter permalink");

  let rewritten = 0;
  for (const path of files) {
    const { body, bodyLine } = parseFrontMatter(sources.get(path)!, path);
    const tree = await parseWithPagePath(body, path, bodyLine);
    const { links, references, definitions } = collect(tree);
    const targets = new Map(definitions.map((d) => [d.identifier, d.url]));
    const urls = [...links.map((l) => l.url), ...references.map((r) => targets.get(r.identifier) ?? "")];
    for (const url of urls) {
      assert.ok(EXTERNAL.test(url) || !PAGE_LINK.test(url), `${path}: ${url} was left as a source link`);
      if (url.startsWith("/")) {
        const at = url.indexOf("#");
        const target = at === -1 ? url : url.slice(0, at);
        assert.ok(pageUrls.has(target), `${path}: ${url} does not resolve to a page`);
        rewritten += 1;
      }
    }
  }
  assert.ok(rewritten > 500, `expected hundreds of rewritten links, got ${rewritten}`);
});
