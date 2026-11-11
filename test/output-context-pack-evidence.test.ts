import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { contextPack, type PackEvidence } from "../src/outputs/context-pack.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "../src/packs/tokens.ts";

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
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
    ...overrides,
  };
}

interface PageOptions {
  readonly title?: string;
  readonly source?: string;
}

function page(url: string, markdown: string, options: PageOptions = {}): Page {
  return {
    url,
    source: { file: options.source ?? "guide/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: options.title ?? "Page",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
  return { config: config(), pages, nav: {}, data };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: { renderPage: () => Promise.resolve(""), report: (diagnostic) => void diagnostics.push(diagnostic) },
  };
}

/** The Markdown pack among the files. */
function markdownOf(files: readonly OutputFile[]): string {
  const found = files.filter((file) => file.path.endsWith(".md"));
  assert.equal(found.length, 1, "one Markdown pack");
  return String(found[0]!.contents);
}

/** The structured twin of the pack, parsed. */
function evidenceOf(files: readonly OutputFile[]): PackEvidence {
  const found = files.filter((file) => file.path.endsWith(".json"));
  assert.equal(found.length, 1, "one structured pack");
  return JSON.parse(String(found[0]!.contents)) as PackEvidence;
}

type Schema = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(new URL("../schema/context-pack.schema.json", import.meta.url), "utf8"),
) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** The schema accepts the evidence, with ajv's findings on failure. */
function assertValid(evidence: PackEvidence): void {
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors, null, 2));
}

/** The sum of a rank's contributions: the score a reader can check. */
function contributionSum(reasons: readonly { readonly contribution: number }[]): number {
  return reasons.reduce((sum, reason) => sum + reason.contribution, 0);
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

const ALPHA = `# Alpha install

Alpha install intro.

## Common

Run the same setup steps to install the engine.

## Alpha only

Alpha-only body about install.
`;

const BETA = `# Beta install

Beta install intro.

## Common

Run the same setup steps to install the engine.

## Beta only

Beta-only body about install.
`;

/** A long page whose mandatory lead alone cannot fit beside the first candidate. */
const LARGE = `# Other install

${Array.from({ length: 120 }, (_, index) => `filler${index}`).join(" ")}.

## Later

Later install notes.
`;

test("the schema is JSON Schema draft 2020-12 and closed", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
});

test("every section left out of a selected page has a stable reason and source span", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const evidence = evidenceOf(await contextPack.run(model, context().ctx));

  assert.ok(evidence.selection.omissions.length > 0, "the tiny budget drops every optional section");
  for (const omission of evidence.selection.omissions) {
    assert.equal(omission.item, "/guide/install/");
    assert.equal(omission.reason, "budget", "a section the budget could not keep says so");
    assert.ok(omission.span.startsWith("guide/install.md:"), omission.span);
    assert.equal(omission.duplicateOf, undefined);
    assert.ok(omission.tokens > 0);
    assert.equal(
      omission.id,
      omission.span.slice(0, omission.span.lastIndexOf("-")),
      "the id is the span's start",
    );
  }
  assert.deepEqual(
    evidence.selection.omissions.map((omission) => omission.text),
    ["Requirements", "Steps", "Troubleshooting"],
    "omissions stay in document order",
  );
  assertValid(evidence);
});

test("a duplicate omission names the kept item and section that replaced it", async () => {
  const model = site(
    [
      page("/alpha/", ALPHA, { title: "Alpha install", source: "guide/alpha.md" }),
      page("/beta/", BETA, { title: "Beta install", source: "guide/beta.md" }),
    ],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const evidence = evidenceOf(await contextPack.run(model, context().ctx));
  const duplicate = evidence.selection.omissions.find((omission) => omission.reason === "duplicate");

  assert.ok(duplicate, "the repeated section is omitted as a duplicate");
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.text, "Common");
  assert.ok(duplicate.span.startsWith("guide/beta.md:"), duplicate.span);
  assert.deepEqual(duplicate.duplicateOf?.item, "/alpha/", "the first kept item owns the section");
  const kept = evidence.items.find((item) => item.id === "/alpha/");
  assert.ok(kept, "the canonical item is in the pack");
  assert.ok(
    kept.sections.some((section) => section.id === duplicate.duplicateOf?.section),
    "the duplicate names a section the kept item still shows",
  );
  assert.ok(markdownOf(await contextPack.run(model, context().ctx)).includes("Run the same setup steps"));
  assertValid(evidence);
});

test("a candidate the budget omits carries its rank score and reasons", async () => {
  const model = site(
    [
      page("/a-install/", INSTALL, { title: "Install the engine", source: "guide/install.md" }),
      page("/z-other/", LARGE, { title: "Other install", source: "guide/other.md" }),
    ],
    { contextPacks: [{ topic: "Install", budget: 120 }] },
  );
  const files = await contextPack.run(model, context().ctx);
  const evidence = evidenceOf(files);

  assert.deepEqual(evidence.items.map((item) => item.id), ["/a-install/"]);
  const omitted = evidence.selection.omitted[0];
  assert.ok(omitted, "the page whose mandatory lead does not fit is omitted");
  assert.equal(omitted.id, "/z-other/");
  assert.equal(omitted.reason, "budget");
  assert.ok(omitted.span.startsWith("guide/other.md:"), omitted.span);
  assert.ok(omitted.score > 0);
  assert.ok(omitted.reasons.length > 0, "the omission can be explained");
  assert.equal(contributionSum(omitted.reasons), omitted.score, "reasons sum to the score exactly");
  assert.ok(
    Math.abs(evidence.items[0]!.rank.score - contributionSum(evidence.items[0]!.rank.reasons)) < 1e-9,
    "a selected item's reasons sum to its score too",
  );
  assertValid(evidence);

  const again = await contextPack.run(model, context().ctx);
  assert.deepEqual(again, files, "the same site gives the same selection bytes");
});

test("the accounting reconciles selected content, required evidence, overhead, and the Markdown", async () => {
  const budget = 20_000;
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget }] },
  );
  const files = await contextPack.run(model, context().ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);
  const accounting = evidence.accounting;

  assert.equal(accounting.requested, budget);
  assert.equal(accounting.used, estimateTokens(markdown).tokens, "used is the final Markdown, not a sum");
  assert.equal(accounting.selected + accounting.required + accounting.overhead, accounting.used);
  assert.ok(accounting.selected > 0);
  assert.ok(accounting.required > 0, "the URL, source, and version lines are priced");
  assert.ok(accounting.overhead > 0, "the title, headings, and separators are priced");
  assert.equal(accounting.remaining, budget - accounting.used);
  assert.equal(accounting.method, TOKEN_METHOD);
  assert.equal(accounting.margin, TOKEN_ERROR_MARGIN);
  assert.equal(accounting.upper, Math.ceil(accounting.used * (1 + TOKEN_ERROR_MARGIN)));
  assert.ok(accounting.reserved > 0, "content the pack cannot drop is reserved");
  assert.equal(accounting.minimum, null, "a fitting pack has no over-budget minimum");
  assertValid(evidence);
});

test("an over-budget pack publishes its minimum feasible cost", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const files = await contextPack.run(model, context().ctx);
  const evidence = evidenceOf(files);
  const accounting = evidence.accounting;

  assert.ok(accounting.used > accounting.requested);
  assert.equal(accounting.remaining, 1 - accounting.used);
  assert.ok(accounting.minimum, "an impossible budget reports the smallest feasible cost");
  assert.equal(accounting.minimum.tokens, accounting.selected + accounting.required + accounting.overhead, "the minimum is the mandatory serialization");
  assert.equal(accounting.minimum.upper, Math.ceil(accounting.minimum.tokens * (1 + TOKEN_ERROR_MARGIN)));
  assert.equal(accounting.reserved, accounting.minimum.upper);
  assertValid(evidence);
});

test("required evidence is explicit per kind, and a selected page never covers a missing version", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const evidence = evidenceOf(await contextPack.run(model, context().ctx));

  const requirements = new Map(evidence.coverage.requirements.map((entry) => [entry.kind, entry]));
  assert.deepEqual(
    [...requirements.keys()],
    ["source", "version", "warning", "dependency"],
    "the four context-request kinds, in a fixed order",
  );
  assert.equal(requirements.get("source")?.satisfied, true);
  assert.deepEqual(requirements.get("source")?.missing, []);

  assert.equal(requirements.get("version")?.satisfied, false, "selection alone proves no version");
  assert.deepEqual(requirements.get("version")?.missing, ["/guide/install/"]);
  assert.equal(requirements.get("version")?.reason, "version.unknown");

  assert.equal(requirements.get("warning")?.satisfied, true);
  assert.equal(requirements.get("dependency")?.satisfied, false);
  assert.deepEqual(requirements.get("dependency")?.missing, ["/guide/install/"]);
  assert.equal(requirements.get("dependency")?.reason, "dependency.unavailable");

  assert.deepEqual(evidence.coverage.unsatisfied, ["version", "dependency"]);
  assertValid(evidence);
});

test("a versioned page satisfies version coverage and shows the version in both files", async () => {
  const model = site(
    [page("/v2/guide/install/", INSTALL, { title: "Install the engine", source: "v2/guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 20_000 }] },
  );
  const files = await contextPack.run(model, context().ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);
  const item = evidence.items[0]!;
  const version = evidence.coverage.requirements.find((entry) => entry.kind === "version");

  assert.equal(item.version, "v2");
  assert.match(markdown, /\n- Version: v2\n/, "the Markdown names the same version the JSON does");
  assert.equal(version?.satisfied, true);
  assert.deepEqual(version?.missing, []);
  assert.deepEqual(evidence.coverage.unsatisfied, ["dependency"]);
  assertValid(evidence);
});

test("compilation warnings are published with their source span", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 1 }] },
  );
  const { ctx, diagnostics } = context();
  const evidence = evidenceOf(await contextPack.run(model, ctx));

  assert.ok(evidence.warnings.length > 0);
  for (const warning of evidence.warnings) {
    assert.ok(warning.id.length > 0);
    assert.ok(warning.message.length > 0);
    assert.ok(warning.span?.startsWith("guide/install.md:"), warning.span ?? "no span");
  }
  assert.deepEqual(
    evidence.warnings.map((warning) => warning.id),
    diagnostics.map((diagnostic) => diagnostic.id),
    "the JSON publishes exactly the warnings the build reports",
  );
  assert.equal(evidence.coverage.requirements.find((entry) => entry.kind === "warning")?.satisfied, true);
  assertValid(evidence);
});

test("Markdown and JSON name identical selected content and repeat byte for byte", async () => {
  const model = site(
    [page("/guide/install/", INSTALL, { title: "Install the engine", source: "guide/install.md" })],
    { contextPacks: [{ topic: "Install", budget: 70 }] },
  );
  const files = await contextPack.run(model, context().ctx);
  const markdown = markdownOf(files);
  const evidence = evidenceOf(files);

  for (const item of evidence.items) {
    assert.ok(markdown.includes(`## ${item.title}`), "the Markdown names the same page");
    assert.ok(markdown.includes(`- Source: \`${item.origin.source}\``), "and the same source");
    assert.ok(markdown.includes(item.content), "and the same selected Markdown");
    for (const section of item.sections) {
      assert.ok(markdown.includes(`## ${section.text}`), `the kept section ${section.text} is shown`);
      assert.equal(
        evidence.selection.omissions.some((omission) => omission.id === section.id),
        false,
        "a kept section is never also reported omitted",
      );
    }
  }

  const again = await contextPack.run(model, context().ctx);
  assert.deepEqual(again, files, "repeated builds are byte-identical");
  assertValid(evidence);
});
