import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { NavTree, OutputFile, Page, Plugin, Site, SiteConfig } from "../src/contracts/index.ts";
import {
  CODE_CONFIG_FILE,
  loadCodeConfig,
  runContentHooks,
  runModelHooks,
  runOutputsHooks,
  type HookName,
} from "../src/plugins/hooks.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

function page(url: string): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  const nav: NavTree = { lists: [] };
  return { config: config(), pages, nav, data: {} };
}

/** A site folder holding the given files; the caller removes it when the test ends. */
function siteRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "plugins-"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

/** A site's code file: `body` declares the plugins and `list` names them in the default export. */
function codeFile(body: string, list: string): Record<string, string> {
  const importPlugin = `import type { Plugin } from ${JSON.stringify(
    pathToFileURL(join(process.cwd(), "src/contracts/index.ts")).href,
  )};\n`;
  const imports = body.includes("Site")
    ? importPlugin + `import type { Site } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/contracts/index.ts")).href)};\n`
    : importPlugin;
  return { [CODE_CONFIG_FILE]: `${imports}${body}export default { plugins: [${list}] };\n` };
}

test("a site without a code file has no plugins and no diagnostic", async () => {
  const root = siteRoot({ "mizzen.yml": "title: T\n" });
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins, []);
    assert.deepEqual(loaded.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the code file lists the plugins a build runs, in order", async () => {
  const root = siteRoot(
    codeFile(
      `const first: Plugin = { name: "first", content: (p) => p };\nconst second: Plugin = { name: "second", model: (s) => s };\n`,
      "first, second",
    ),
  );
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.plugins.map((plugin) => plugin.name), ["first", "second"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an edited code file is imported again, and unchanged content reuses its module", async () => {
  const first = codeFile(`const plugin: Plugin = { name: "first" };\n`, "plugin");
  const root = siteRoot(first);
  try {
    const before = await loadCodeConfig(root);
    assert.deepEqual(before.plugins.map((plugin) => plugin.name), ["first"]);

    const unchanged = await loadCodeConfig(root);
    assert.equal(unchanged.plugins[0], before.plugins[0], "unchanged content reuses the same module instance");

    const second = codeFile(`const plugin: Plugin = { name: "second" };\n`, "plugin");
    writeFileSync(join(root, CODE_CONFIG_FILE), second[CODE_CONFIG_FILE]!);

    const after = await loadCodeConfig(root);
    assert.deepEqual(after.plugins.map((plugin) => plugin.name), ["second"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a code file with an empty list is an ordinary site", async () => {
  const root = siteRoot(codeFile("", ""));
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins, []);
    assert.deepEqual(loaded.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a code file Node cannot import is one error naming the file", async () => {
  const root = siteRoot({ [CODE_CONFIG_FILE]: "export default { plugins: [ ] \n" });
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins, []);
    assert.equal(loaded.diagnostics.length, 1);
    const [diagnostic] = loaded.diagnostics;
    assert.equal(diagnostic?.id, "plugin.load-failed");
    assert.equal(diagnostic?.severity, "error");
    assert.ok(diagnostic?.message.includes(CODE_CONFIG_FILE), `the file is named: ${diagnostic?.message}`);
    assert.deepEqual(diagnostic?.pos, { file: CODE_CONFIG_FILE, line: 1, column: 1, endLine: 1, endColumn: 1 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a default export with no plugin list is an error", async () => {
  const root = siteRoot({ [CODE_CONFIG_FILE]: "export default { title: \"T\" };\n" });
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins, []);
    assert.equal(loaded.diagnostics[0]?.id, "plugin.invalid-code-config");
    assert.ok(loaded.diagnostics[0]?.message.includes("`plugins`"), loaded.diagnostics[0]?.message ?? "");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a file with no default export is an error", async () => {
  const root = siteRoot({ [CODE_CONFIG_FILE]: "export const plugins = [];\n" });
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins, []);
    assert.equal(loaded.diagnostics[0]?.id, "plugin.invalid-code-config");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an entry that is not a plugin is dropped and the sound entries run", async () => {
  const root = siteRoot(
    codeFile(
      `const good: Plugin = { name: "good", content: (p) => p };\nconst bad = { content: (p: unknown) => p };\n`,
      "good, \"not a plugin\", bad, 7",
    ),
  );
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(loaded.plugins.map((plugin) => plugin.name), ["good"]);
    assert.equal(loaded.diagnostics.length, 3);
    for (const diagnostic of loaded.diagnostics) {
      assert.equal(diagnostic.id, "plugin.invalid-plugin");
      assert.equal(diagnostic.severity, "error");
      assert.ok(diagnostic.message.includes(CODE_CONFIG_FILE), diagnostic.message);
    }
    assert.ok(loaded.diagnostics[0]?.message.includes("Plugin 2"), loaded.diagnostics[0]?.message ?? "");
    assert.ok(loaded.diagnostics[0]?.message.includes("not an object"), loaded.diagnostics[0]?.message ?? "");
    assert.ok(loaded.diagnostics[1]?.message.includes("Plugin 3"), loaded.diagnostics[1]?.message ?? "");
    assert.ok(loaded.diagnostics[1]?.message.includes("no non-empty"), loaded.diagnostics[1]?.message ?? "");
    assert.ok(loaded.diagnostics[2]?.message.includes("Plugin 4"), loaded.diagnostics[2]?.message ?? "");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the content hooks run in plugin order and each sees what the one before returned", async () => {
  const seen: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "first",
      content: (p) => {
        seen.push(`first:${p.title}`);
        return { ...p, title: "one" };
      },
    },
    {
      name: "second",
      content: (p) => {
        seen.push(`second:${p.title}`);
        return { ...p, title: "two" };
      },
    },
    { name: "no content hook", model: (s) => s },
  ];
  const result = await runContentHooks(plugins, page("/install/"));
  assert.deepEqual(seen, ["first:/install/", "second:one"]);
  assert.equal(result.value.title, "two");
  assert.deepEqual(result.diagnostics, []);
});

test("the model hooks run once with the assembled site", async () => {
  const plugins: Plugin[] = [
    { name: "adds a page", model: (s) => ({ ...s, pages: [...s.pages, page("/extra/")] }) },
    {
      name: "counts what the one before made",
      model: (s) => ({ ...s, pages: [...s.pages, page(`/count/${s.pages.length}/`)] }),
    },
  ];
  const result = await runModelHooks(plugins, site([page("/install/")]));
  assert.deepEqual(result.value.pages.map((p) => p.url), ["/install/", "/extra/", "/count/2/"]);
  assert.deepEqual(result.diagnostics, []);
});

test("the output hooks get the files and the site they came from", async () => {
  const files: OutputFile[] = [{ path: "index.html", contents: "<html></html>" }];
  const plugins: Plugin[] = [
    {
      name: "adds a file",
      outputs: (list, s) => [...list, { path: `robots-${s.config.title}.txt`, contents: "Sitemap: /sitemap.xml" }],
    },
  ];
  const input = [...files];
  const result = await runOutputsHooks(plugins, input, site([page("/install/")]));
  assert.deepEqual(result.value.map((f) => f.path), ["index.html", "robots-Mizzen.txt"]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(input, files, "the list handed in is not changed");
});

test("an async hook is awaited before the next plugin runs", async () => {
  const order: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "slow",
      content: async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("slow");
        return { ...p, title: "slow" };
      },
    },
    {
      name: "fast",
      content: (p) => {
        order.push(`fast:${p.title}`);
        return p;
      },
    },
  ];
  const result = await runContentHooks(plugins, page("/install/"));
  assert.deepEqual(order, ["slow", "fast:slow"]);
  assert.deepEqual(result.diagnostics, []);
});

test("a hook that throws is an error naming the plugin and the value before it is kept", async () => {
  const plugins: Plugin[] = [
    { name: "good", content: (p) => ({ ...p, title: "kept" }) },
    {
      name: "broken",
      content: () => {
        throw new Error("boom");
      },
    },
    { name: "after", content: (p) => ({ ...p, lang: "fa" }) },
  ];
  const input = page("/install/");
  const result = await runContentHooks(plugins, input);
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "plugin.hook-failed");
  assert.equal(diagnostic?.severity, "error");
  assert.ok(diagnostic?.message.includes("broken"), `the plugin is named: ${diagnostic?.message}`);
  assert.ok(diagnostic?.message.includes("content hook"), diagnostic?.message);
  assert.ok(diagnostic?.message.includes("boom"), diagnostic?.message);
  assert.equal(diagnostic?.pos?.file, CODE_CONFIG_FILE, "the diagnostic points at the site's code file");
  assert.equal(result.value.title, "kept", "the plugins after a throwing one still run");
  assert.equal(result.value.lang, "fa");
  assert.deepEqual(input, page("/install/"), "the page handed in is not changed");
});

/** A plugin whose hook returns something the stage cannot use: only a test can do that. */
function badHookPlugin(name: string, hook: HookName, value: unknown): Plugin {
  return { name, [hook]: () => value } as Plugin;
}

test("a hook that returns an unusable value is an error naming the plugin", async () => {
  const content = await runContentHooks([badHookPlugin("confused", "content", "not a page")], page("/install/"));
  assert.equal(content.value.title, "/install/");
  assert.equal(content.diagnostics.length, 1);
  assert.equal(content.diagnostics[0]?.id, "plugin.hook-failed");
  assert.ok(content.diagnostics[0]?.message.includes("confused"), content.diagnostics[0]?.message ?? "");
  assert.ok(content.diagnostics[0]?.message.includes("a page"), content.diagnostics[0]?.message ?? "");

  const model = await runModelHooks([badHookPlugin("silent", "model", undefined)], site([]));
  assert.equal(model.diagnostics.length, 1);
  assert.ok(model.diagnostics[0]?.message.includes("silent"), model.diagnostics[0]?.message ?? "");
  assert.ok(model.diagnostics[0]?.message.includes("a site model"), model.diagnostics[0]?.message ?? "");

  const outputs = await runOutputsHooks([badHookPlugin("wrong", "outputs", "not a list")], [], site([]));
  assert.deepEqual(outputs.value, []);
  assert.ok(outputs.diagnostics[0]?.message.includes("a list of output files"), outputs.diagnostics[0]?.message ?? "");
});

test("a plugin that implements no hook costs nothing", async () => {
  const plugins: Plugin[] = [{ name: "empty" }];
  const content = await runContentHooks(plugins, page("/install/"));
  assert.deepEqual(content.diagnostics, []);
  assert.equal(content.value.url, "/install/");
  const model = await runModelHooks(plugins, site([]));
  assert.deepEqual(model.diagnostics, []);
  const outputs = await runOutputsHooks(plugins, [], site([]));
  assert.deepEqual(outputs.diagnostics, []);
});

test("a test plugin adds a page and an output file", async () => {
  const root = siteRoot(
    codeFile(
      `const plugin: Plugin = {
  name: "changelog",
  model: (s: Site) => ({ ...s, pages: [...s.pages, { ...s.pages[0]!, url: "/changelog/", title: "Changelog" }] }),
  outputs: (files, s: Site) => [...files, { path: "changelog.txt", contents: s.pages.map((p) => p.url).join("\\n") }],
};
`,
      "plugin",
    ),
  );
  try {
    const { plugins, diagnostics } = await loadCodeConfig(root);
    assert.deepEqual(diagnostics, []);

    const model = await runModelHooks(plugins, site([page("/install/")]));
    assert.deepEqual(model.diagnostics, []);
    assert.deepEqual(model.value.pages.map((p) => p.url), ["/install/", "/changelog/"]);

    const outputs = await runOutputsHooks(plugins, [{ path: "index.html", contents: "" }], model.value);
    assert.deepEqual(outputs.diagnostics, []);
    assert.deepEqual(outputs.value, [
      { path: "index.html", contents: "" },
      { path: "changelog.txt", contents: "/install/\n/changelog/" },
    ]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a plugin loaded from the code file that throws names itself", async () => {
  const root = siteRoot(
    codeFile(
      `const plugin: Plugin = {
  name: "thrower",
  content() {
    throw new Error("no thanks");
  },
};
`,
      "plugin",
    ),
  );
  try {
    const { plugins, diagnostics } = await loadCodeConfig(root);
    assert.deepEqual(diagnostics, []);
    const result = await runContentHooks(plugins, page("/install/"));
    assert.equal(result.diagnostics.length, 1);
    assert.ok(result.diagnostics[0]?.message.includes("thrower"), result.diagnostics[0]?.message ?? "");
    assert.ok(result.diagnostics[0]?.message.includes("no thanks"), result.diagnostics[0]?.message ?? "");
    assert.equal(result.value.url, "/install/");
  } finally {
    rmSync(root, { recursive: true });
  }
});
