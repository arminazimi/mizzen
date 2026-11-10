import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Heading, Root } from "mdast";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";

const RTL_SITE = fileURLToPath(new URL("../fixtures/rtl-site", import.meta.url));

/** Parses a fixture page the way the pipeline will: front matter stripped, positions offset. */
async function parsePage(name: string): Promise<Root> {
  const source = readFileSync(`${RTL_SITE}/${name}`, "utf8");
  const { body, bodyLine } = parseFrontMatter(source, name);
  return parseMarkdown(body, bodyLine);
}

function headingIds(tree: Root): (string | undefined)[] {
  return tree.children
    .filter((node): node is Heading => node.type === "heading")
    .map((heading) => (heading.data as { id?: string } | undefined)?.id);
}

async function idsOf(markdown: string): Promise<(string | undefined)[]> {
  return headingIds(await parseMarkdown(markdown));
}

async function headingTexts(markdown: string): Promise<string[]> {
  const tree = await parseMarkdown(markdown);
  return tree.children
    .filter((node): node is Heading => node.type === "heading")
    .map((heading) => heading.children.map((child) => (child.type === "text" ? child.value : "")).join(""));
}

test("slug is discovered and runs after GFM", async () => {
  const plugins = await loadMarkdownPlugins();
  const slug = plugins.find((p) => p.name === "slug");
  assert.ok(slug, "the slug plugin is discovered from the plugins folder");
  assert.equal(slug?.order, 10);
  assert.equal(plugins[0]?.name, "gfm");
});

test("Persian headings in fixtures/rtl-site get readable ids", async () => {
  const expected: Record<string, string[]> = {
    "index.md": ["راهنمای-بیکن", "شروع-کنید"],
    "install.md": ["نصب", "با-مدیر-بسته"],
    "configuration.md": ["پیکربندی", "نمونه"],
    "commands.md": ["دستورها", "استقرار"],
    "faq.md": ["پرسشهای-متداول", "آیا-بیکن-به-سرور-نیاز-دارد", "چرا-فهرست-نسخهها-خالی-است", "کد-خروج-چیست"],
  };
  for (const [name, ids] of Object.entries(expected)) {
    assert.deepEqual(await headingIds(await parsePage(name)), ids, name);
    for (const id of ids) {
      assert.ok(!id.includes("\u200c"), `${name}: ${id} has no ZWNJ`);
      assert.match(id, /[\u0600-\u06FF]/, `${name}: ${id} keeps its Arabic-script letters`);
    }
  }
});

test("ASCII headings follow GitHub anchor rules, including the kept trailing hyphen", async () => {
  assert.deepEqual(
    await idsOf("# Hello, World!\n\n## C++ vs C#\n\n### foo_bar\n\n#### emoji ✨\n\n##### 50% off\n\n###### API Design\n"),
    ["hello-world", "c-vs-c", "foo_bar", "emoji-", "50-off", "api-design"],
  );
});

test("ZWNJ is removed while Persian and Arabic letters and marks survive", async () => {
  const ids = await idsOf("## پرسش‌های متداول\n\n## كتاب العربية\n\n## أهلاً وسهلاً\n");
  assert.deepEqual(ids, ["پرسشهای-متداول", "كتاب-العربية", "أهلاً-وسهلاً"]);
  for (const id of ids) {
    assert.ok(!id?.includes("\u200c"), "no ZWNJ in the id");
  }
});

test("a {#custom-id} at the end overrides and is stripped from the text", async () => {
  assert.deepEqual(await idsOf("## نصب {#install}\n"), ["install"]);
  assert.deepEqual(await headingTexts("## نصب {#install}\n"), ["نصب"]);
});

test("custom ids skip the duplicate counter", async () => {
  assert.deepEqual(await idsOf("## یک {#same}\n\n## دو {#same}\n"), ["same", "same"]);
});

test("an invalid or non-final marker stays literal text", async () => {
  assert.deepEqual(await idsOf("## x {#}\n\n## y {#a b}\n"), ["x-", "y-a-b"]);
  assert.deepEqual(await headingTexts("## x {#}\n"), ["x {#}"]);
  assert.deepEqual(await idsOf("## نصب {#install} راهنما\n"), ["نصب-install-راهنما"]);
});

test("duplicate headings get -1 and -2", async () => {
  const body = "# شروع کنید\n\n# شروع کنید\n\n# شروع کنید\n";
  assert.deepEqual(await idsOf(body), ["شروع-کنید", "شروع-کنید-1", "شروع-کنید-2"]);
});

test("the occurrence loop matches github-slugger when a numbered slug already exists", async () => {
  assert.deepEqual(await idsOf("# hello-1\n\n# hello\n\n# hello\n"), ["hello-1", "hello", "hello-2"]);
});

test("each page slugs independently", async () => {
  const body = "# شروع کنید\n";
  assert.deepEqual(await idsOf(body), ["شروع-کنید"]);
  assert.deepEqual(await idsOf(body), ["شروع-کنید"], "no counter carries over from the previous parse");
});

test("ids land on data.id and data.hProperties.id of headings only, positions untouched", async () => {
  const tree = await parseMarkdown("# Title\n\nparagraph\n", 5);
  const heading = tree.children[0] as Heading;
  assert.equal(heading.type, "heading");
  const data = heading.data as { id?: string; hProperties?: { id?: string } } | undefined;
  assert.equal(data?.id, "title");
  assert.equal(data?.hProperties?.id, "title");
  assert.equal(heading.position?.start.line, 5);
  const paragraph = tree.children[1];
  assert.equal(paragraph?.type, "paragraph");
  assert.equal(paragraph?.data, undefined);
});
