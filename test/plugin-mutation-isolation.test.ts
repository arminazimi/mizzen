import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, NavTree, OutputFile, Page, Plugin, Site, SiteConfig } from "../src/contracts/index.ts";
import { runContentHooks, runModelHooks, runOutputsHooks } from "../src/plugins/hooks.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** The writable view a test plugin takes: every contract field is read-only. */
type MutablePage = { title: string; frontMatter: Record<string, unknown>; headings: Heading[] };
type MutableSite = { pages: MutablePage[]; nav: Record<string, unknown[]>; data: Record<string, unknown> };

/** A site config with the defaults a build fills in. */
function config(): SiteConfig {
  return {
    title: "Mizzen",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  };
}

/** A page with the nested data a mutation has to reach: front matter and headings. */
function page(url = "/install/"): Page {
  return {
    url,
    source: pos,
    frontMatter: { title: "Install", tags: ["guide"] },
    title: "Install",
    lang: "en",
    dir: "ltr",
    headings: [{ depth: 1, id: "install", text: "Install", pos }],
    html: "<h1>Install</h1>",
    markdown: "# Install",
    kind: "doc",
  };
}

/** A site model with nested page, navigation, and `_data` content. */
function site(pages: readonly Page[] = [page()]): Site {
  const nav: NavTree = { main: [{ title: "Install", url: "/install/" }] };
  return { config: config(), pages, nav, data: { team: { members: ["ada"] } } };
}

/** Output files with text and bytes, the two contents a hook can change in place. */
function files(): OutputFile[] {
  return [
    { path: "index.html", contents: "<html></html>" },
    { path: "bytes.bin", contents: new Uint8Array([1, 2, 3]) },
  ];
}

/** Each file as `path:contents`, with bytes listed, so a test can assert what one hook saw. */
function seenFiles(list: readonly OutputFile[]): string {
  return list
    .map((file) => `${file.path}:${typeof file.contents === "string" ? file.contents : `[${file.contents.join(",")}]`}`)
    .join("|");
}

test("a content hook that mutates its page and then throws leaves the retained page and the next plugin untouched", async () => {
  const input = page();
  const before = structuredClone(input);
  const seen: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "mutator",
      content: (p) => {
        const mutable = p as unknown as MutablePage;
        mutable.title = "mutated";
        mutable.frontMatter.tags = ["mutated"];
        mutable.headings.length = 0;
        throw new Error("boom");
      },
    },
    {
      name: "after",
      content: (p) => {
        seen.push(`${p.title} ${JSON.stringify(p.frontMatter.tags)} ${p.headings.length}`);
        return p;
      },
    },
  ];

  const result = await runContentHooks(plugins, input);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.ok(result.diagnostics[0]?.message.includes("mutator"), result.diagnostics[0]?.message ?? "");
  assert.deepEqual(seen, ["Install [\"guide\"] 1"], "the next plugin sees the value from before the failed hook");
  assert.deepEqual(result.value, before, "the retained page keeps its nested fields");
  assert.deepEqual(input, before, "the page handed in is not changed");
});

test("a content hook that mutates its page and returns an unusable one keeps the page before it", async () => {
  const input = page();
  const plugins: Plugin[] = [
    {
      name: "bad return",
      content: (p) => {
        const mutable = p as unknown as MutablePage;
        mutable.title = "mutated";
        mutable.frontMatter.banner = true;
        return { ...p, html: 7 } as unknown as Page;
      },
    },
    { name: "after", content: (p) => ({ ...p, lang: "fa" }) },
  ];

  const result = await runContentHooks(plugins, input);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.ok(result.diagnostics[0]?.message.includes("`html`"), result.diagnostics[0]?.message ?? "");
  assert.equal(result.value.title, "Install", "the last usable page is kept");
  assert.equal("banner" in result.value.frontMatter, false, "the refused hook's front matter is not kept");
  assert.equal(result.value.lang, "fa", "a later plugin still runs");
  assert.equal(input.title, "Install", "the page handed in is not changed");
});

test("a content hook that mutates its page and misses its deadline leaves the retained page untouched", async () => {
  const input = page();
  const plugins: Plugin[] = [
    {
      name: "stuck",
      content: (p) => {
        (p as unknown as MutablePage).title = "mutated";
        (p.frontMatter as Record<string, unknown>).banner = true;
        return new Promise<Page>(() => {});
      },
    },
    { name: "after", content: (p) => ({ ...p, lang: "fa" }) },
  ];

  const result = await runContentHooks(plugins, input, { timeoutMs: 20 });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-timeout");
  assert.equal(result.value.title, "Install");
  assert.equal("banner" in result.value.frontMatter, false);
  assert.equal(result.value.lang, "fa", "a later plugin still runs after a deadline");
});

test("a model hook that mutates pages, navigation, and site data and then throws leaves the retained model untouched", async () => {
  const start = site();
  const before = structuredClone(start);
  const seen: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "mutator",
      model: (s) => {
        const mutable = s as unknown as MutableSite;
        mutable.pages[0]!.title = "mutated";
        mutable.pages[0]!.frontMatter.tags = ["mutated"];
        mutable.nav.main = [];
        mutable.data.team = { members: ["mutated"] };
        throw new Error("boom");
      },
    },
    {
      name: "after",
      model: (s) => {
        seen.push(
          `${s.pages[0]?.title} ${JSON.stringify(s.pages[0]?.frontMatter.tags)} ${s.nav.main?.length} ${JSON.stringify(s.data.team)}`,
        );
        return s;
      },
    },
  ];

  const result = await runModelHooks(plugins, start);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.deepEqual(seen, ["Install [\"guide\"] 1 {\"members\":[\"ada\"]}"], "the next plugin sees the model before the failed hook");
  assert.deepEqual(result.value, before, "the retained model keeps its nested page, nav, and data");
  assert.deepEqual(start, before, "the model handed in is not changed");
});

test("a model hook that mutates the model and returns an unusable one keeps the model before it", async () => {
  const start = site();
  const plugins: Plugin[] = [
    {
      name: "bad return",
      model: (s) => {
        const mutable = s as unknown as MutableSite;
        mutable.pages[0]!.title = "mutated";
        mutable.data.team = "mutated";
        return { ...s, pages: [{ ...s.pages[0], url: 1 }] } as unknown as Site;
      },
    },
    { name: "after", model: (s) => ({ ...s, data: { ...s.data, kept: true } }) },
  ];

  const result = await runModelHooks(plugins, start);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.ok(result.diagnostics[0]?.message.includes("`pages[0].url`"), result.diagnostics[0]?.message ?? "");
  assert.equal(result.value.pages[0]?.title, "Install", "the last usable model is kept");
  assert.deepEqual(result.value.data.team, { members: ["ada"] }, "the refused hook's data is not kept");
  assert.equal(result.value.data.kept, true, "a later plugin still runs");
  assert.deepEqual(start.data.team, { members: ["ada"] }, "the model handed in is not changed");
});

test("a model hook that mutates the model and misses its deadline leaves the retained model untouched", async () => {
  const start = site();
  const plugins: Plugin[] = [
    {
      name: "stuck",
      model: (s) => {
        (s.pages[0] as unknown as MutablePage).title = "mutated";
        (s.data as Record<string, unknown>).team = "mutated";
        return new Promise<Site>(() => {});
      },
    },
    { name: "after", model: (s) => ({ ...s, data: { ...s.data, kept: true } }) },
  ];

  const result = await runModelHooks(plugins, start, { timeoutMs: 20 });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-timeout");
  assert.equal(result.value.pages[0]?.title, "Install");
  assert.deepEqual(result.value.data.team, { members: ["ada"] });
  assert.equal(result.value.data.kept, true, "a later plugin still runs after a deadline");
});

test("an outputs hook that mutates text, bytes, and the list and then throws leaves the retained files untouched", async () => {
  const input = files();
  const before = structuredClone(input);
  const seen: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "mutator",
      outputs: (list) => {
        (list[0] as unknown as { contents: string }).contents = "mutated";
        (list[1]!.contents as Uint8Array)[0] = 9;
        (list as OutputFile[]).push({ path: "mutated.txt", contents: "mutated" });
        throw new Error("boom");
      },
    },
    {
      name: "after",
      outputs: (list) => {
        seen.push(seenFiles(list));
        return list;
      },
    },
  ];

  const result = await runOutputsHooks(plugins, input, site());
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.deepEqual(seen, ["index.html:<html></html>|bytes.bin:[1,2,3]"], "the next plugin sees the files before the failed hook");
  assert.deepEqual(result.value, before, "the retained text, bytes, and paths are the originals");
  assert.deepEqual(input, before, "the files handed in are not changed");
});

test("an outputs hook that mutates the files and returns unusable ones keeps the files before it", async () => {
  const input = files();
  const plugins: Plugin[] = [
    {
      name: "bad return",
      outputs: (list) => {
        (list[1]!.contents as Uint8Array)[0] = 9;
        (list[0] as unknown as { contents: string }).contents = "mutated";
        return [{ path: "index.html", contents: 7 as unknown as string }];
      },
    },
    { name: "after", outputs: (list) => [...list, { path: "after.txt", contents: "after" }] },
  ];

  const result = await runOutputsHooks(plugins, input, site());
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.ok(result.diagnostics[0]?.message.includes("neither text nor bytes"), result.diagnostics[0]?.message ?? "");
  assert.deepEqual(result.value.map((file) => file.path), ["index.html", "bytes.bin", "after.txt"], "the last usable list is kept");
  assert.equal(result.value[0]?.contents, "<html></html>", "the refused hook's text is not kept");
  assert.deepEqual(result.value[1]?.contents, new Uint8Array([1, 2, 3]), "the refused hook's bytes are not kept");
  assert.deepEqual(input, files(), "the files handed in are not changed");
});

test("an outputs hook that mutates the files and misses its deadline leaves the retained files untouched", async () => {
  const input = files();
  const plugins: Plugin[] = [
    {
      name: "stuck",
      outputs: (list) => {
        (list[1]!.contents as Uint8Array)[1] = 9;
        (list as OutputFile[]).push({ path: "mutated.txt", contents: "mutated" });
        return new Promise<readonly OutputFile[]>(() => {});
      },
    },
    { name: "after", outputs: (list) => [...list, { path: "after.txt", contents: "after" }] },
  ];

  const result = await runOutputsHooks(plugins, input, site(), { timeoutMs: 20 });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-timeout");
  assert.deepEqual(result.value.map((file) => file.path), ["index.html", "bytes.bin", "after.txt"]);
  assert.deepEqual(result.value[1]?.contents, new Uint8Array([1, 2, 3]));
  assert.deepEqual(input, files(), "the files handed in are not changed");
});

test("an outputs hook that mutates the site it is given reaches neither the retained site nor the next plugin", async () => {
  const model = site();
  const before = structuredClone(model);
  const seen: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "site mutator",
      outputs: (_list, s) => {
        (s.pages[0] as unknown as MutablePage).title = "mutated";
        (s.data as Record<string, unknown>).team = "mutated";
        throw new Error("boom");
      },
    },
    {
      name: "after",
      outputs: (list, s) => {
        seen.push(`${s.pages[0]?.title} ${JSON.stringify(s.data.team)}`);
        return list;
      },
    },
  ];

  const result = await runOutputsHooks(plugins, files(), model);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "plugin.hook-failed");
  assert.deepEqual(seen, ["Install {\"members\":[\"ada\"]}"], "the next plugin reads the site from before the failed hook");
  assert.deepEqual(model, before, "the site the caller keeps is not changed");
});

test("a successful hook's replacement is kept, later plugins run in order, and the value handed in is not changed", async () => {
  const order: string[] = [];

  const input = page();
  const content = await runContentHooks(
    [
      {
        name: "first",
        content: (p) => {
          order.push(`first:${p.title}`);
          const mutable = p as unknown as MutablePage;
          mutable.title = "one";
          mutable.frontMatter.tags = ["one"];
          return p;
        },
      },
      {
        name: "second",
        content: (p) => {
          order.push(`second:${p.title}:${JSON.stringify(p.frontMatter.tags)}`);
          return { ...p, title: "two" };
        },
      },
    ],
    input,
  );
  assert.deepEqual(order, ["first:Install", "second:one:[\"one\"]"], "content hooks run in declaration order");
  assert.equal(content.value.title, "two", "the replacement of the last successful hook is the stage's value");
  assert.deepEqual(content.value.frontMatter.tags, ["one"], "a successful hook's nested change is kept");
  assert.equal(input.title, "Install", "the page handed in is not changed");
  assert.deepEqual(content.diagnostics, []);

  const start = site();
  const model = await runModelHooks(
    [
      {
        name: "first",
        model: (s) => {
          order.push(`model first:${s.pages.length}`);
          return { ...s, pages: [...s.pages, page("/added/")] };
        },
      },
      {
        name: "second",
        model: (s) => {
          order.push(`model second:${s.pages.length}`);
          return s;
        },
      },
    ],
    start,
  );
  assert.deepEqual(order.slice(2), ["model first:1", "model second:2"], "model hooks run in declaration order");
  assert.deepEqual(model.value.pages.map((p) => p.url), ["/install/", "/added/"]);
  assert.deepEqual(start.pages.map((p) => p.url), ["/install/"], "the model handed in is not changed");

  const bytes = new Uint8Array([7, 8]);
  const outputs = await runOutputsHooks(
    [
      {
        name: "first",
        outputs: (list, s) => {
          order.push(`outputs first:${list.length}:${s.pages.length}`);
          return [...list, { path: "added.bin", contents: bytes }];
        },
      },
      {
        name: "second",
        outputs: (list) => {
          order.push(`outputs second:${list.length}`);
          return [...list, { path: "after.txt", contents: "after" }];
        },
      },
    ],
    files(),
    site(),
  );
  assert.deepEqual(order.slice(4), ["outputs first:2:1", "outputs second:3"], "outputs hooks run in declaration order");
  assert.deepEqual(outputs.value.map((file) => file.path), ["index.html", "bytes.bin", "added.bin", "after.txt"]);
  assert.deepEqual(outputs.value[2]?.contents, bytes, "a successful hook's bytes reach the next plugin and the final value");
  assert.deepEqual(outputs.diagnostics, []);
});
