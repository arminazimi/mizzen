import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Diagnostic, FrontMatter, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { agentPath, pageAgent, readAgentBlock } from "../src/outputs/page-agent.ts";

const pos = { file: "guide/install.md", line: 4, column: 1, endLine: 4, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
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
    ...overrides,
  };
}

/**
 * A page whose front matter is written as given. The frozen contract types `agent` with only `edit`, `source`, and
 * `notes`, while the front-matter schema and N24's parser read `owner` and `rules` too, so this helper takes a plain
 * record and casts it instead of making every test cast its block.
 */
function page(url: string, data: Record<string, unknown> = {}, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: { ...pos, file: overrides.source?.file ?? pos.file },
    frontMatter: data as FrontMatter,
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, data: {} };
}

/** An output context that records every diagnostic and never renders a page. */
function context(reports: Diagnostic[] = []): OutputContext {
  return {
    renderPage: () => Promise.reject(new Error("the page agent output must not render pages")),
    report: (diagnostic) => {
      reports.push(diagnostic);
    },
  };
}

async function run(model: Site, reports: Diagnostic[] = []): Promise<readonly OutputFile[]> {
  return pageAgent.run(model, context(reports));
}

async function only(model: Site, reports: Diagnostic[] = []): Promise<OutputFile> {
  const files = await run(model, reports);
  assert.equal(files.length, 1, "one page writes one file");
  return files[0]!;
}

/** The body of a file, parsed. */
function bodyOf(file: OutputFile): Record<string, unknown> {
  return JSON.parse(String(file.contents)) as Record<string, unknown>;
}

test("the output is named after its file", () => {
  assert.equal(pageAgent.name, "page-agent");
});

test("a page writes its URL, source, and every agent key in the fixed order", async () => {
  const file = await only(
    site([
      page(
        "/guide/install/",
        {
          agent: {
            notes: "Change the constant, not the page.",
            source: "src/version.ts",
            rules: ["Never change the version table by hand", "Update the screenshots"],
            owner: "docs-team",
            edit: false,
          },
        },
        { source: { ...pos, file: "guide/install.md" } },
      ),
    ]),
  );

  const body = bodyOf(file);
  assert.deepEqual(body, {
    url: "/guide/install/",
    source: "guide/install.md",
    agent: {
      edit: false,
      owner: "docs-team",
      rules: ["Never change the version table by hand", "Update the screenshots"],
      source: "src/version.ts",
      notes: "Change the constant, not the page.",
    },
  });
  assert.deepEqual(Object.keys(body), ["url", "source", "agent"]);
  assert.deepEqual(Object.keys(body.agent as object), ["edit", "owner", "rules", "source", "notes"]);
  assert.ok(String(file.contents).endsWith("\n"), "the file ends with a line feed");
});

test("a key the block does not set is left out", async () => {
  const file = await only(site([page("/a/", { agent: { owner: "docs-team" } })]));
  assert.deepEqual(bodyOf(file).agent, { owner: "docs-team" });
  assert.equal(String(file.contents).includes("notes"), false);
  assert.equal(String(file.contents).includes("edit"), false);
});

test("a page without an agent block writes no file", async () => {
  assert.deepEqual(await run(site([page("/a/")])), []);
});

test("an empty agent block writes no file", async () => {
  assert.deepEqual(await run(site([page("/a/", { agent: {} })])), []);
  assert.deepEqual(await run(site([page("/a/", { agent: null as never })])), []);
});

test("an empty rules list is a key, so the page writes a file with it", async () => {
  const file = await only(site([page("/a/", { agent: { rules: [] } })]));
  assert.deepEqual(bodyOf(file).agent, { rules: [] });
});

test("several pages are sorted by path code point, and two runs write the same bytes", async () => {
  const model = site([page("/b/", { agent: { owner: "b" } }), page("/a/", { agent: { owner: "a" } })]);
  const first = await run(model);
  const second = await run(model);
  assert.deepEqual(
    first.map((f) => f.path),
    ["a/agent.json", "b/agent.json"],
  );
  assert.deepEqual(
    first.map((f) => f.contents),
    second.map((f) => f.contents),
  );
});

test("a pretty URL writes agent.json inside its folder, the root at agent.json, and an HTML file as its .agent.json name", () => {
  assert.equal(agentPath("/guide/install/"), "/guide/install/agent.json");
  assert.equal(agentPath("/guide/install"), "/guide/install/agent.json");
  assert.equal(agentPath("/"), "/agent.json");
  assert.equal(agentPath("/404.html"), "/404.agent.json", "an HTML file gets its own name, not page-json's 404.json");
  assert.equal(agentPath("/feed.xml"), undefined, "a URL that names a file of another kind has no agent file");
});

test("the base is stripped from the file path, and the URL keeps it", async () => {
  const files = await run(
    site([page("/evergreen/", { agent: { owner: "root" } }), page("/evergreen/guide/install/", { agent: { owner: "docs" } })], {
      base: "/evergreen",
    }),
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["agent.json", "guide/install/agent.json"],
  );
  const install = JSON.parse(String(files[1]!.contents)) as { url: string; agent: { owner: string } };
  assert.equal(install.url, "/evergreen/guide/install/");
  assert.equal(install.agent.owner, "docs");
});

test("an app page, an asset page, and a URL that names another file write no agent file", async () => {
  const files = await run(
    site([
      page("/guide/", { agent: { owner: "docs" } }),
      page("/dashboard/", { agent: { owner: "app" } }, { kind: "app" }),
      page("/logo.svg", { agent: { owner: "asset" } }, { kind: "asset" }),
      page("/feed.xml", { agent: { owner: "feed" } }),
    ]),
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["guide/agent.json"],
  );
});

test("quotes, backslashes, line breaks, and non-ASCII text survive the JSON", async () => {
  const notes = 'Say "hello" \\ and stop.\nNext line — سلام';
  const file = await only(site([page("/a/", { agent: { notes, rules: ['A "quoted" rule'] } })]));
  const body = bodyOf(file) as { agent: { notes: string; rules: string[] } };
  assert.equal(body.agent.notes, notes);
  assert.deepEqual(body.agent.rules, ['A "quoted" rule']);
  assert.ok(String(file.contents).includes('\\"hello\\"'), "the quotes are escaped on disk");
  assert.ok(String(file.contents).includes("\\n"), "the line break is escaped on disk");
});

test("a block that is not a mapping is reported and writes no file", async () => {
  const reports: Diagnostic[] = [];
  const model = site([page("/a/", { agent: "docs-team" as never }, { source: { ...pos, file: "guide/a.md", line: 5 } })]);
  assert.deepEqual(await run(model, reports), []);

  assert.equal(reports.length, 1);
  const d = reports[0]!;
  assert.equal(d.id, "agent.not-a-mapping");
  assert.equal(d.severity, "error");
  assert.equal(d.pos?.file, "guide/a.md");
  assert.deepEqual(d.pos, { file: "guide/a.md", line: 1, column: 1, endLine: 4, endColumn: 1 });
});

test("a wrong key type is reported and the readable keys are still written", async () => {
  const reports: Diagnostic[] = [];
  const file = await only(
    site([page("/a/", { agent: { owner: 42, rules: ["Run the tests"] } })]),
    reports,
  );

  assert.deepEqual(bodyOf(file).agent, { rules: ["Run the tests"] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.id, "agent.invalid-type");
  assert.equal(reports[0]!.severity, "error");
  assert.match(reports[0]!.message, /agent\.owner/);
});

test("a block whose every key is unreadable is reported and writes no file", async () => {
  const reports: Diagnostic[] = [];
  const model = site([page("/a/", { agent: { owner: true, edit: "yes" } })]);
  assert.deepEqual(await run(model, reports), []);
  assert.deepEqual(reports.map((d) => d.id), ["agent.invalid-type", "agent.invalid-type"]);
});

test("an unknown key is a warning, and the readable keys are written", async () => {
  const reports: Diagnostic[] = [];
  const file = await only(site([page("/a/", { agent: { owner: "docs-team", rule: "x" } })]), reports);
  assert.deepEqual(bodyOf(file).agent, { owner: "docs-team" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.id, "agent.unknown-key");
  assert.equal(reports[0]!.severity, "warning");
});

test("the helper reads the block of a page without reporting a valid one", () => {
  const reports: Diagnostic[] = [];
  const block = readAgentBlock(page("/a/", { agent: { owner: "docs-team" } }), (d) => reports.push(d));
  assert.deepEqual(block, { owner: "docs-team" });
  assert.deepEqual(reports, []);
});

test("a build from source files writes agent.json for the page with a block and nothing for the page without one", async () => {
  const root = await mkdtemp(join(tmpdir(), "page-agent-"));
  try {
    await mkdir(join(root, "guide"), { recursive: true });
    await writeFile(join(root, "mizzen.yml"), "title: Example\n");
    await writeFile(
      join(root, "guide", "install.md"),
      [
        "---",
        "title: Install",
        "agent:",
        "  owner: docs-team",
        "  rules:",
        "    - Never change the version table by hand",
        "---",
        "",
        "# Install",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "index.md"), "---\ntitle: Home\n---\n\n# Home\n");

    const { site: model, diagnostics } = await buildModel(root);
    const reports: Diagnostic[] = [];
    const files = await run(model, reports);

    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    assert.deepEqual(reports, []);
    assert.deepEqual(
      files.map((f) => f.path),
      ["guide/install/agent.json"],
    );
    assert.deepEqual(bodyOf(files[0]!), {
      url: "/guide/install/",
      source: "guide/install.md",
      agent: { owner: "docs-team", rules: ["Never change the version table by hand"] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid block in a source file is reported at its front matter", async () => {
  const root = await mkdtemp(join(tmpdir(), "page-agent-bad-"));
  try {
    await writeFile(join(root, "mizzen.yml"), "title: Example\n");
    await writeFile(join(root, "install.md"), "---\ntitle: Install\nagent: docs-team\n---\n\n# Install\n");

    const { site: model } = await buildModel(root);
    const reports: Diagnostic[] = [];
    assert.deepEqual(await run(model, reports), []);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.id, "agent.not-a-mapping");
    assert.deepEqual(reports[0]!.pos, { file: "install.md", line: 1, column: 1, endLine: 4, endColumn: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
