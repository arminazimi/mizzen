import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ContextRequest } from "../src/contracts/context-request.ts";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { main, parseArgs, usage } from "../src/cli/index.ts";
import { readStandardInput } from "../src/cli/pack-request.ts";
import { buildModel } from "../src/model/build.ts";
import { contextPack, type PackEvidence } from "../src/outputs/context-pack.ts";
import { compilePack } from "../src/packs/compile.ts";
import { estimateTokens } from "../src/packs/tokens.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-pack-request-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes a request beside the site and returns its path. */
function requestFile(root: string, value: unknown): string {
  const path = join(root, "request.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function capture(readStdin?: () => Promise<string>) {
  const writes: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    errors,
    logs,
    io: {
      write: (text: string) => {
        writes.push(text);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
      ...(readStdin === undefined ? {} : { readStdin }),
    },
  };
}

/** Runs `pack --request -`, feeding `value` as JSON on stdin. */
async function runRequest(root: string, value: unknown, extra: readonly string[] = []) {
  const buffers = capture(async () => JSON.stringify(value));
  const code = await main(["pack", root, "--request", "-", ...extra], buffers.io);
  return { code, ...buffers };
}

const INSTALL = `# Install the engine

Install the engine before you configure the site. Install once per machine.

## Requirements

You need Node 24 or newer and a terminal to install.

## Steps

Run the installer and follow the prompts to install.

## Troubleshooting

If the installer fails, read the log.
`;

const DEPLOY = `# Deploy the site

Deploy the built site behind a proxy.

## Build

Run the build and deploy the output folder.

## Rollback

Restore the previous release if a deploy fails.
`;

const PERSIAN = `---
lang: fa
dir: rtl
---
# نصب موتور

Install the engine in Persian.

## نیازها

به Node 24 نیاز دارید.
`;

/** A request with only the fields every case needs. */
function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, task: { goal: "install the engine" }, budget: { maxTokens: 6000 }, ...extra };
}

test("parseArgs: --request, pack formats, and conflicting options", () => {
  assert.deepEqual(parseArgs(["pack", "site", "--request", "req.json"]), {
    options: { command: "pack", root: "site", request: "req.json" },
  });
  assert.deepEqual(parseArgs(["pack", "--request", "-", "--format", "json"]), {
    options: { command: "pack", root: ".", request: "-", format: "json" },
  });
  assert.deepEqual(parseArgs(["pack", "--request", "-", "--format", "markdown"]), {
    options: { command: "pack", root: ".", request: "-", format: "markdown" },
  });

  assert.equal("error" in parseArgs(["pack", "--request", "req.json", "--topic", "Install"]), true);
  assert.equal("error" in parseArgs(["pack", "--request", "req.json", "--budget", "6000"]), true);
  assert.equal("error" in parseArgs(["pack", "--format", "yaml"]), true);
  assert.equal("error" in parseArgs(["pack", "--format", "sarif"]), true);
  assert.equal("error" in parseArgs(["build", "--request", "req.json"]), true);
  assert.equal("error" in parseArgs(["pack", "--request"]), true);

  assert.ok(usage.includes("--request <file|->"), "the usage string documents --request");
  assert.ok(usage.includes("markdown or json for pack"), "the usage string documents the pack formats");
});

test("a file request and a stdin request produce the same bytes without a theme or topics", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  const path = requestFile(root, request());
  try {
    const file = capture();
    assert.equal(await main(["pack", root, "--request", path], file.io), 0);
    assert.deepEqual(file.errors, []);
    assert.equal(file.writes.length, 1);

    const stdin = capture(async () => readFileSync(path, "utf8"));
    assert.equal(await main(["pack", root, "--request", "-"], stdin.io), 0);
    assert.deepEqual(stdin.errors, []);
    assert.deepEqual(stdin.writes, file.writes);

    const jsonFile = capture();
    assert.equal(await main(["pack", root, "--request", path, "--format", "json"], jsonFile.io), 0);
    const jsonStdin = capture(async () => readFileSync(path, "utf8"));
    assert.equal(await main(["pack", root, "--request", "-", "--format", "json"], jsonStdin.io), 0);
    assert.deepEqual(jsonStdin.writes, jsonFile.writes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readStandardInput consumes a stream without closing it", async () => {
  const stream = new Readable({ read() {}, autoDestroy: false });
  stream.push('{"version":1}');
  stream.push(null);
  const text = await readStandardInput(stream);
  assert.equal(text, '{"version":1}');
  assert.equal(stream.readableEnded, true, "the read reaches the end of the stream");
  assert.equal(stream.destroyed, false, "the caller's stream stays open after the read");
});

test("include, exclude, and locale constrain the candidates", async () => {
  const root = tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/deploy.md": DEPLOY,
    "fa/install.md": PERSIAN,
  });
  try {
    const hinted = await runRequest(
      root,
      request({ include: ["guide/install.md"], exclude: ["guide/deploy.md"], constraints: { locale: "en" } }),
      ["--format", "json"],
    );
    assert.equal(hinted.code, 0);
    assert.deepEqual(hinted.errors, []);
    const hintedEvidence = JSON.parse(hinted.writes[0]!) as PackEvidence;
    assert.deepEqual(hintedEvidence.items.map((item) => item.id), ["/guide/install/"]);

    const fa = await runRequest(root, request({ include: ["/fa/install/"], constraints: { locale: "fa" } }), [
      "--format",
      "json",
    ]);
    const faEvidence = JSON.parse(fa.writes[0]!) as PackEvidence;
    assert.deepEqual(faEvidence.items.map((item) => item.id), ["/fa/install/"]);
    assert.equal(faEvidence.items[0]!.locale.lang, "fa");

    const en = await runRequest(root, request({ include: ["/fa/install/"], constraints: { locale: "en" } }), [
      "--format",
      "json",
    ]);
    const enEvidence = JSON.parse(en.writes[0]!) as PackEvidence;
    assert.deepEqual(enEvidence.items.map((item) => item.id), ["/guide/install/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact and bounded version constraints select the allowed folders", async () => {
  const pages: Record<string, string> = { "mizzen.yml": "title: Demo\n" };
  for (const folder of ["v1", "v2", "v3"]) {
    pages[`${folder}/guide/install.md`] = `# Install ${folder}\n\nInstall the engine in ${folder}.\n\n## Steps\n\nRun the ${folder} installer.\n`;
  }
  const root = tree(pages);
  try {
    const exact = await runRequest(root, request({ constraints: { version: { exact: "v2" } } }), [
      "--format",
      "json",
    ]);
    assert.equal(exact.code, 0);
    const exactEvidence = JSON.parse(exact.writes[0]!) as PackEvidence;
    assert.deepEqual(exactEvidence.items.map((item) => item.id), ["/v2/guide/install/"]);
    assert.equal(exactEvidence.items[0]!.version, "v2");

    const bounded = await runRequest(root, request({ constraints: { version: { min: "v1", max: "v2" } } }), [
      "--format",
      "json",
    ]);
    assert.equal(bounded.code, 0);
    const boundedEvidence = JSON.parse(bounded.writes[0]!) as PackEvidence;
    assert.deepEqual(
      boundedEvidence.items.map((item) => item.id).sort(),
      ["/v1/guide/install/", "/v2/guide/install/"],
    );
    assert.ok(boundedEvidence.items.every((item) => item.version !== "v3"));

    const missing = await runRequest(root, request({ constraints: { version: { exact: "v9" } } }));
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.writes, []);
    assert.match(missing.errors.join("\n"), /no page/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserved tokens are held back from optional sections", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  try {
    const roomy = await runRequest(root, request({ include: ["guide/install.md"], budget: { maxTokens: 200 } }));
    assert.equal(roomy.code, 0);
    assert.match(roomy.writes[0]!, /## Requirements/);
    assert.match(roomy.writes[0]!, /## Steps/);

    const reserved = await runRequest(
      root,
      request({ include: ["guide/install.md"], budget: { maxTokens: 200, reservedTokens: 150 } }),
    );
    assert.equal(reserved.code, 0);
    assert.ok(estimateTokens(reserved.writes[0]!).tokens <= 200, "the pack stays within maxTokens");
    assert.doesNotMatch(reserved.writes[0]!, /## Requirements/);
    assert.ok(
      estimateTokens(reserved.writes[0]!).tokens < estimateTokens(roomy.writes[0]!).tokens,
      "the reserve leaves less room for optional sections",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("required refs pin pages and sections, and missing evidence is an error", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL, "guide/deploy.md": DEPLOY });
  try {
    const pinned = await runRequest(
      root,
      request({
        task: { goal: "deploy the site" },
        requiredEvidence: { refs: ["/guide/install/"], source: true, versions: true },
      }),
      ["--format", "json"],
    );
    assert.equal(pinned.code, 0);
    const evidence = JSON.parse(pinned.writes[0]!) as PackEvidence;
    assert.ok(evidence.items.some((item) => item.id === "/guide/install/"), "the ref forces its page");
    const install = evidence.items.find((item) => item.id === "/guide/install/")!;
    assert.match(install.content, /- Source span: `guide\/install\.md:/);
    assert.match(install.content, /- Version: current; locale: en/);

    const section = await runRequest(
      root,
      request({
        include: ["guide/install.md"],
        budget: { maxTokens: 80 },
        requiredEvidence: { refs: ["guide/install.md:9:1"] },
      }),
    );
    assert.equal(section.code, 0);
    assert.match(section.writes[0]!, /## Steps/, "a named section cannot be trimmed away");

    const missing = await runRequest(
      root,
      request({ requiredEvidence: { refs: ["/guide/does-not-exist/"] } }),
    );
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.writes, []);
    assert.match(missing.errors.join("\n"), /context-pack\.missing-evidence/);

    const blocked = await runRequest(
      root,
      request({ exclude: ["guide/install.md"], requiredEvidence: { refs: ["/guide/install/"] } }),
    );
    assert.equal(blocked.code, 1);
    assert.deepEqual(blocked.writes, []);
    assert.match(blocked.errors.join("\n"), /context-pack\.evidence-excluded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a section ref with no real section is missing evidence, not a page match", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  try {
    const missing = await runRequest(
      root,
      request({
        include: ["guide/install.md"],
        requiredEvidence: { refs: ["guide/install.md:999:1"] },
      }),
    );
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.writes, [], "no pack is produced for evidence that does not exist");
    assert.match(missing.errors.join("\n"), /context-pack\.missing-evidence/);

    const found = await runRequest(
      root,
      request({
        include: ["guide/install.md"],
        requiredEvidence: { refs: ["guide/install.md:9:1"] },
      }),
    );
    assert.equal(found.code, 0, "a real section ref is still satisfied");
    assert.match(found.writes[0]!, /## Steps/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiled evidence carries rank, selection, accounting, coverage, and warnings", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  try {
    const value = request({
      include: ["guide/install.md"],
      requiredEvidence: { refs: ["guide/install.md:9:1"] },
    });
    const install = await runRequest(root, value, ["--format", "json"]);
    const markdown = await runRequest(root, value);
    assert.equal(install.code, 0);
    assert.equal(markdown.code, 0);
    const evidence = JSON.parse(install.writes[0]!) as PackEvidence;
    const item = evidence.items[0]!;
    assert.equal(typeof item.rank.score, "number");
    assert.ok(item.rank.reasons.length > 0);
    assert.ok(Array.isArray(evidence.selection.omitted));
    assert.ok(Array.isArray(evidence.selection.omissions));
    assert.equal(
      evidence.accounting.selected + evidence.accounting.required + evidence.accounting.overhead,
      evidence.accounting.used,
      "every token is accounted for",
    );
    assert.equal(
      evidence.accounting.used,
      estimateTokens(markdown.writes[0]!).tokens,
      "the accounting measures the Markdown the same run wrote",
    );
    assert.equal(evidence.coverage.requirements.length, 4);
    assert.ok(Array.isArray(evidence.warnings));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compilePack passes the task kind to ranking", async () => {
  const root = tree({
    "mizzen.yml": "title: Demo\n",
    "guide/alpha.md": "# Alpha guide\n\nSee [Beta](beta.md).\n",
    "guide/beta.md": "# Beta guide\n\nAlpha also appears here.\n",
  });
  try {
    const model = await buildModel(root);
    const base: ContextRequest = {
      version: 1,
      task: { goal: "alpha" },
      include: [],
      exclude: [],
      constraints: {},
      budget: { maxTokens: 6000 },
      requiredEvidence: { refs: [], source: false, versions: false, warnings: false, dependencies: false },
    };
    const context = { renderPage: () => Promise.resolve(""), report: () => {} };
    const explained = await compilePack(model.site, { ...base, task: { goal: "alpha", kind: "explain" } }, context);
    const plain = await compilePack(model.site, base, context);
    assert.ok(explained && plain);
    const scoreOf = (pack: typeof explained): number =>
      pack.evidence.items.find((item) => item.id === "/guide/beta/")!.rank.score;
    assert.notEqual(
      scoreOf(explained),
      scoreOf(plain),
      "the explain profile weights inbound links differently, so the kind reaches rankPages",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown and JSON contain the same items and the build's own identity", async () => {
  const root = tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/deploy.md": DEPLOY,
    "_data/context-packs.yml": "- topic: Install\n  budget: 6000\n",
  });
  try {
    const markdown = await runRequest(root, request({ include: ["guide/install.md"] }));
    assert.equal(markdown.code, 0);
    const json = await runRequest(root, request({ include: ["guide/install.md"] }), ["--format", "json"]);
    assert.equal(json.code, 0);
    const evidence = JSON.parse(json.writes[0]!) as PackEvidence;
    assert.match(evidence.build.id, /^[0-9a-f]{64}$/);
    assert.equal(evidence.build.engine, "0.1.0");
    for (const item of evidence.items) {
      assert.equal(item.build, evidence.build.id);
      assert.ok(markdown.writes[0]!.includes(`## ${item.title}`), `Markdown names ${item.id}`);
      assert.ok(markdown.writes[0]!.includes(item.content.trim()), `Markdown shows ${item.id}'s content`);
    }

    const model = await buildModel(root);
    const [file] = await contextPack.run(model.site, {
      renderPage: () => Promise.resolve(""),
      report: () => {},
    });
    assert.ok(file, "the build writes a structured pack");
    const built = JSON.parse(String(file.contents)) as PackEvidence;
    assert.equal(evidence.build.id, built.build.id, "the request and the build share one build identity");
    assert.equal(evidence.build.engine, built.build.engine);
    assert.deepEqual(
      evidence.items.map((item) => item.id),
      built.items.map((item) => item.id),
      "the request selects the same items as the build",
    );
    for (let index = 0; index < evidence.items.length; index += 1) {
      assert.equal(evidence.items[index]!.content, built.items[index]!.content);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("required warnings and dependencies appear in both outputs", async () => {
  const config: SiteConfig = {
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
  const page = (url: string, title: string, markdown: string, source: string): Page => ({
    url,
    source: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  });
  const alpha = page("/guide/alpha/", "Alpha guide", "# Alpha guide\n\nAlpha intro. See [Beta](beta.md).\n", "guide/alpha.md");
  const beta = page("/guide/beta/", "Beta guide", "# Beta guide\n\nBeta intro.\n", "guide/beta.md");
  const site: Site = { config, pages: [alpha, beta], nav: {}, data: {} };
  const warnings: Diagnostic[] = [
    {
      id: "test.alpha-warning",
      severity: "warning",
      message: "Alpha needs a review.",
      pos: { file: "guide/alpha.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    },
    {
      id: "test.beta-warning",
      severity: "warning",
      message: "Beta needs a review.",
      pos: { file: "guide/beta.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    },
  ];
  const contextRequest: ContextRequest = {
    version: 1,
    task: { goal: "alpha" },
    include: ["/guide/alpha/"],
    exclude: ["/guide/beta/"],
    constraints: {},
    budget: { maxTokens: 6000 },
    requiredEvidence: { refs: [], source: true, versions: true, warnings: true, dependencies: true },
  };
  const diagnostics: Diagnostic[] = [];
  const compiled = await compilePack(
    site,
    contextRequest,
    { renderPage: () => Promise.resolve(""), report: (diagnostic) => void diagnostics.push(diagnostic) },
    { warnings },
  );

  assert.ok(compiled, "the request compiles");
  assert.deepEqual(diagnostics, []);
  assert.match(compiled.evidence.build.id, /^[0-9a-f]{64}$/);
  const [item] = compiled.evidence.items;
  assert.equal(item?.id, "/guide/alpha/");
  assert.match(item.content, /- Warning: Alpha needs a review\./);
  assert.match(item.content, /- Depends on: Beta guide \(\/guide\/beta\//);
  assert.doesNotMatch(item.content, /Beta needs a review/, "only selected pages contribute warnings");
  assert.match(compiled.markdown, /- Warning: Alpha needs a review\./);
  assert.match(compiled.markdown, /- Depends on: Beta guide \(\/guide\/beta\//);
});

test("malformed, schema, cross-field, and usage errors leave stdout clean", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  const path = requestFile(root, request());
  try {
    const malformed = await runRequestWithoutJson(root);
    assert.equal(malformed.code, 2);
    assert.deepEqual(malformed.writes, []);
    assert.match(malformed.errors.join("\n"), /not valid JSON/);

    const schema = await runRequest(root, { version: 1, task: { goal: "install" } });
    assert.equal(schema.code, 2);
    assert.deepEqual(schema.writes, []);
    assert.match(schema.errors.join("\n"), /\/budget/);
    assert.match(schema.errors.join("\n"), /context-request\.missing/);

    const crossField = await runRequest(
      root,
      request({ include: ["/guide/install/"], exclude: ["/guide/install/"] }),
    );
    assert.equal(crossField.code, 2);
    assert.deepEqual(crossField.writes, []);
    assert.match(crossField.errors.join("\n"), /context-request\.include-excluded/);

    const unknown = capture();
    assert.equal(await main(["pack", root, "--nope"], unknown.io), 2);
    assert.deepEqual(unknown.writes, []);
    assert.match(unknown.errors.join("\n"), /unknown option: --nope/);

    const conflict = capture();
    assert.equal(await main(["pack", root, "--request", path, "--topic", "Install"], conflict.io), 2);
    assert.deepEqual(conflict.writes, []);
    assert.match(conflict.errors.join("\n"), /--request and --topic cannot be used together/);

    const badFormat = capture();
    assert.equal(await main(["pack", root, "--format", "sarif"], badFormat.io), 2);
    assert.deepEqual(badFormat.writes, []);
    assert.match(badFormat.errors.join("\n"), /--format for pack must be markdown or json/);

    const empty = await runRequest(root, request({ task: { goal: "quantum tunneling" } }));
    assert.equal(empty.code, 1);
    assert.deepEqual(empty.writes, []);
    assert.match(empty.errors.join("\n"), /context-pack\.no-pages/);

    const missingFile = capture();
    assert.equal(await main(["pack", root, "--request", join(root, "absent.json")], missingFile.io), 2);
    assert.deepEqual(missingFile.writes, []);
    assert.match(missingFile.errors.join("\n"), /cannot read the request/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Runs a request that is not valid JSON at all. */
async function runRequestWithoutJson(root: string) {
  const buffers = capture(async () => "{not json");
  const code = await main(["pack", root, "--request", "-"], buffers.io);
  return { code, ...buffers };
}

test("--out writes the same bytes atomically and leaves stdout empty", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  const path = requestFile(root, request());
  const out = join(root, "nested", "pack.md");
  const jsonOut = join(root, "nested", "pack.json");
  try {
    const stdout = capture();
    assert.equal(await main(["pack", root, "--request", path], stdout.io), 0);

    const file = capture();
    assert.equal(await main(["pack", root, "--request", path, "--out", out], file.io), 0);
    assert.deepEqual(file.writes, []);
    assert.deepEqual(file.errors, []);
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out, "utf8"), stdout.writes[0]);

    const jsonStdout = capture();
    assert.equal(await main(["pack", root, "--request", path, "--format", "json"], jsonStdout.io), 0);
    const jsonFile = capture();
    assert.equal(await main(["pack", root, "--request", path, "--format", "json", "--out", jsonOut], jsonFile.io), 0);
    assert.deepEqual(jsonFile.writes, []);
    assert.equal(readFileSync(jsonOut, "utf8"), jsonStdout.writes[0]);

    assert.equal(
      readdirSync(join(root, "nested")).some((name) => name.startsWith(".mizzen-pack-")),
      false,
      "no staging folder is left behind",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the topic path keeps working and can print its structured evidence", async () => {
  const root = tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/deploy.md": DEPLOY,
    "_data/context-packs.yml": "- topic: Install\n  budget: 6000\n",
  });
  try {
    const markdown = capture();
    assert.equal(await main(["pack", root, "--topic", "install"], markdown.io), 0);
    assert.match(markdown.writes[0]!, /^# Context pack: Install\n/);

    const json = capture();
    assert.equal(await main(["pack", root, "--topic", "install", "--format", "json"], json.io), 0);
    const evidence = JSON.parse(json.writes[0]!) as PackEvidence;
    assert.equal(evidence.topic.name, "Install");
    assert.ok(evidence.items.some((item) => item.id === "/guide/install/"));
    for (const item of evidence.items) assert.ok(markdown.writes[0]!.includes(item.content.trim()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
