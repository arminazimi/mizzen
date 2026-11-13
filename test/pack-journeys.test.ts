/**
 * Issue #30: a task request compiles a complete pack, end to end, through the CLI.
 *
 * These tests drive `main(["pack", <dir>, "--request", <file>, ...])` from `src/cli/index.ts`
 * against temporary sites. They pin the four journeys a caller actually walks — setup, debugging,
 * API usage, and a version-bound migration — and the evidence each one must publish: every selected
 * item with its build, source span, rank reasons, token share; every omitted page and section with
 * a reason; a hard budget that never silently drops required evidence; version-bound selection;
 * byte-identical output; and request errors that leave stdout clean.
 *
 * The request contract is `src/contracts/context-request.ts` (version 1); its schema is
 * `schema/context-request.schema.json`. The compiler is `src/packs/compile.ts`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MAX_REQUEST_BYTES } from "../src/cli/pack-request.ts";
import { main } from "../src/cli/index.ts";
import { version } from "../src/index.ts";
import type { PackEvidence, PackItem } from "../src/outputs/context-pack.ts";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "../src/packs/tokens.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pack-journeys-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes a request beside the site and returns its path. */
function requestFile(root: string, name: string, value: unknown): string {
  const path = join(root, `${name}.json`);
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

/** Runs a request file through `main` with the given output format. */
async function runFile(
  root: string,
  value: unknown,
  extra: readonly string[] = ["--format", "json"],
) {
  const path = requestFile(root, "request", value);
  const buffers = capture();
  const code = await main(["pack", root, "--request", path, ...extra], buffers.io);
  return { code, path, ...buffers };
}

/** Runs a request file and parses its JSON evidence, failing the test on any other outcome. */
async function runJson(root: string, value: unknown): Promise<PackEvidence> {
  const run = await runFile(root, value);
  assert.equal(run.code, 0, run.errors.join("\n"));
  assert.deepEqual(run.errors, []);
  assert.equal(run.writes.length, 1);
  return JSON.parse(run.writes[0]!) as PackEvidence;
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

const TROUBLESHOOT = `# Troubleshoot a failed deploy

Debug a failed deploy by reading the build log and the proxy error page.

## Read the log

Find the first error in the log; later errors are usually a consequence of it.

## Retry the deploy

Fix the cause and retry the deploy from a clean build.
`;

const API = `# Search API

Call the search API endpoint to query the site index.

## Request

Send a GET request to \`/api/search?q=install\` and read the JSON result.

## Response

The response lists the matching pages with their titles and URLs.
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

/** The site the four journeys share: guides, an API page, a Persian page, and three versions. */
function journeySite(): string {
  const files: Record<string, string> = {
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/deploy.md": DEPLOY,
    "guide/troubleshoot.md": TROUBLESHOOT,
    "reference/api.md": API,
    "fa/guide/install.md": PERSIAN,
  };
  for (const folder of ["v1", "v2", "v3"]) {
    files[`${folder}/guide/install.md`] = `# Install the engine ${folder}

Install the engine for ${folder} before you configure the site.

## Steps

Run the ${folder} installer and follow the prompts.
`;
  }
  return tree(files);
}

/** The two-page site used to force a page and section omission under one budget. */
function omissionSite(): string {
  return tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/upgrade.md": `# Upgrade the engine

Upgrade the engine after you install it, keeping the previous configuration for a rollback.

## Check the version

Read the installed engine version before you upgrade so the next install is repeatable.

## Replace the files

Copy the new engine files over the installed ones and keep the old folder aside.

## Verify the upgrade

Open the site after the upgrade and confirm the install still serves every page.
`,
  });
}

/** A request with the fields every journey needs. */
function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    task: { goal: "install the engine" },
    budget: { maxTokens: 6000 },
    ...extra,
  };
}

/** Asserts a pack fits a hard budget, with the estimator's margin published. */
function assertFits(evidence: PackEvidence, maxTokens: number, label: string): void {
  const accounting = evidence.accounting;
  assert.equal(accounting.requested, maxTokens, label);
  assert.equal(accounting.method, TOKEN_METHOD, `${label}: the estimator is named`);
  assert.equal(accounting.margin, TOKEN_ERROR_MARGIN, `${label}: the estimator margin is visible`);
  assert.equal(
    accounting.upper,
    Math.ceil(accounting.used * (1 + TOKEN_ERROR_MARGIN)),
    `${label}: upper grows the exact estimate by the documented margin`,
  );
  assert.ok(accounting.used <= maxTokens, `${label}: used ${accounting.used} exceeds ${maxTokens}`);
  assert.ok(accounting.upper <= maxTokens, `${label}: upper ${accounting.upper} exceeds ${maxTokens}`);
  assert.equal(
    accounting.selected + accounting.required + accounting.overhead,
    accounting.used,
    `${label}: selected + required + overhead is exactly used`,
  );
  assert.equal(accounting.remaining, maxTokens - accounting.used, `${label}: remaining is exact`);
  assert.equal(accounting.minimum, null, `${label}: a fitting pack has no over-budget minimum`);
  assert.deepEqual(evidence.warnings, [], `${label}: a fitting pack reports no warning`);
  assert.ok(evidence.items.length > 0, `${label}: a journey writes at least one item`);
}

/** The one selected item with this URL. */
function itemOf(evidence: PackEvidence, id: string): PackItem {
  const item = evidence.items.find((entry) => entry.id === id);
  assert.ok(item, `expected an item for ${id}, got ${evidence.items.map((entry) => entry.id).join(", ")}`);
  return item;
}

test("four task journeys compile end to end inside their constraints and hard budget", async () => {
  const root = journeySite();
  try {
    // Setup: implement/install. The include hint pins the install page first; exclude, locale, and
    // the required source/version lines constrain every item.
    const setup = await runJson(
      root,
      request({
        task: { goal: "install the engine", kind: "implement" },
        include: ["guide/install.md"],
        exclude: ["guide/deploy.md"],
        constraints: { locale: "en" },
        requiredEvidence: { refs: [], source: true, versions: true },
      }),
    );
    assertFits(setup, 6000, "setup");
    assert.equal(setup.items[0]!.id, "/guide/install/", "the include hint pins the install page first");
    assert.ok(!setup.items.some((item) => item.id === "/guide/deploy/"), "the exclude hint keeps deploy out");
    assert.ok(!setup.items.some((item) => item.id.startsWith("/fa/")), "the locale keeps the Persian page out");
    for (const item of setup.items) {
      assert.equal(item.locale.lang, "en", `setup: ${item.id} is the requested locale`);
      assert.match(item.content, /^- Source span: `.+:\d+:\d+-\d+:\d+`$/m, `setup: ${item.id} carries its source`);
      assert.match(item.content, /^- Version: (?:v[\d.]+|current); locale: en$/m, `setup: ${item.id} carries version and locale`);
    }

    // Debugging: the task kind reaches ranking, the include page is first, deploy is excluded.
    const debug = await runJson(
      root,
      request({
        task: { goal: "debug a failed deploy", kind: "debug" },
        include: ["guide/troubleshoot.md"],
        exclude: ["guide/deploy.md"],
        constraints: { locale: "en" },
      }),
    );
    assertFits(debug, 6000, "debug");
    assert.equal(debug.items[0]!.id, "/guide/troubleshoot/");
    assert.ok(!debug.items.some((item) => item.id === "/guide/deploy/"));
    assert.ok(debug.items.every((item) => item.locale.lang === "en"));
    assert.match(itemOf(debug, "/guide/troubleshoot/").content, /build log/);

    // API usage: an explain task over the API page; the page's endpoint survives selection.
    const api = await runJson(
      root,
      request({
        task: { goal: "call the search API endpoint", kind: "explain" },
        include: ["reference/api.md"],
        exclude: ["guide/deploy.md"],
        constraints: { locale: "en" },
      }),
    );
    assertFits(api, 6000, "api");
    assert.equal(api.items[0]!.id, "/reference/api/");
    assert.ok(!api.items.some((item) => item.id === "/guide/deploy/"));
    assert.ok(api.items.every((item) => item.locale.lang === "en"));
    assert.match(itemOf(api, "/reference/api/").content, /\/api\/search\?q=install/);

    // A bounded version request: only v1, v2, and current docs may supply context; v3 is filtered
    // before ranking, so it is neither selected nor merely omitted.
    const bounded = await runJson(
      root,
      request({
        task: { goal: "install the engine", kind: "migrate" },
        exclude: ["guide/deploy.md"],
        constraints: { locale: "en", version: { min: "v1", max: "v2" } },
      }),
    );
    assertFits(bounded, 6000, "bounded version");
    assert.ok(!bounded.items.some((item) => item.id.startsWith("/v3/")), "v3 is outside the bound");
    assert.ok(!bounded.selection.omitted.some((omission) => omission.id.startsWith("/v3/")));
    assert.ok(bounded.items.every((item) => item.version === null || item.version === "v1" || item.version === "v2"));
    assert.ok(bounded.items.some((item) => item.version === "v1"));
    assert.ok(bounded.items.some((item) => item.version === "v2"));
    assert.ok(bounded.items.every((item) => item.locale.lang === "en"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compiled pack explains selection, omission, source, and every token", async () => {
  const root = omissionSite();
  try {
    const value = request({
      include: ["guide/install.md"],
      budget: { maxTokens: 120 },
      requiredEvidence: { refs: ["guide/install.md:9:1"], source: true, versions: true },
    });
    const json = await runFile(root, value);
    assert.equal(json.code, 0, json.errors.join("\n"));
    assert.deepEqual(json.errors, []);
    const evidence = JSON.parse(json.writes[0]!) as PackEvidence;

    assert.equal(evidence.version, 1);
    assert.match(evidence.build.id, /^[0-9a-f]{64}$/);
    assert.equal(evidence.build.engine, version);
    assert.equal(evidence.topic.name, "install the engine");
    assert.equal(evidence.topic.budget, 120);

    // Every item names its build, page and section ids, source spans, rank reasons, and content.
    for (const item of evidence.items) {
      assert.equal(item.build, evidence.build.id, `${item.id}: one build identity`);
      assert.equal(item.id, item.url, `${item.id}: the id is the page URL`);
      assert.match(item.hash, /^[0-9a-f]{64}$/, `${item.id}: the page hash is a SHA-256`);
      assert.equal(item.origin.source.startsWith("/"), false, `${item.id}: the source path is site-relative`);
      assert.ok(
        item.origin.span.startsWith(`${item.origin.source}:`),
        `${item.id}: the origin span starts at its source`,
      );
      assert.match(item.origin.span, /:\d+:\d+-\d+:\d+$/, `${item.id}: the origin span has positions`);
      assert.ok(item.rank.reasons.length > 0, `${item.id}: the ranking explains itself`);
      const summed = item.rank.reasons.reduce((sum, reason) => sum + reason.contribution, 0);
      assert.ok(Math.abs(summed - item.rank.score) < 1e-9, `${item.id}: every rank reason sums to the score`);
      for (const reason of item.rank.reasons) {
        assert.equal(typeof reason.factor, "string", `${item.id}: a reason names its factor`);
        assert.ok(reason.code.length > 0, `${item.id}: a reason names its evidence`);
        assert.equal(typeof reason.contribution, "number", `${item.id}: a reason names its contribution`);
      }
      assert.ok(item.content.length > 0, `${item.id}: selected content is shown`);
      for (const section of item.sections) {
        assert.match(section.id, /^.+:\d+:\d+$/, `${item.id}: a section id is a block id`);
        assert.ok(
          section.span.startsWith(`${item.origin.source}:`),
          `${item.id}: a section span starts at the page source`,
        );
        assert.ok(section.text.length > 0, `${item.id}: a section names its heading`);
      }
    }

    const install = itemOf(evidence, "/guide/install/");
    assert.ok(
      install.sections.some((section) => section.id === "guide/install.md:9:1" && section.text === "Steps"),
      "the required section is a real kept section",
    );
    assert.match(install.content, /^- Source span: `guide\/install\.md:/m, "the required source line is kept");
    assert.match(install.content, /^- Version: current; locale: en$/m, "the required version line is kept");

    // Every ranked candidate the budget left out is named with a reason and its own rank evidence.
    assert.deepEqual(
      evidence.selection.omitted.map((omission) => omission.id),
      ["/guide/upgrade/"],
      "the page the budget left out is named",
    );
    for (const omission of evidence.selection.omitted) {
      assert.equal(omission.reason, "budget");
      assert.ok(omission.span.startsWith("guide/upgrade.md:"));
      assert.ok(omission.score > 0);
      assert.ok(omission.reasons.length > 0);
      assert.ok(!evidence.items.some((item) => item.id === omission.id), "an omitted page is not also selected");
    }

    // Every optional section left out of a selected page is named with its reason and its cost.
    assert.deepEqual(
      evidence.selection.omissions.map((omission) => [omission.item, omission.id, omission.text, omission.reason]),
      [
        ["/guide/install/", "guide/install.md:5:1", "Requirements", "budget"],
        ["/guide/install/", "guide/install.md:13:1", "Troubleshooting", "budget"],
      ],
    );
    for (const omission of evidence.selection.omissions) {
      assert.ok(omission.tokens > 0);
      assert.ok(omission.span.startsWith("guide/install.md:"));
      assert.ok(evidence.items.some((item) => item.id === omission.item), "an omission belongs to a selected item");
      assert.ok(
        !install.sections.some((section) => section.id === omission.id),
        "an omitted section is not also kept",
      );
    }
    assert.equal(
      evidence.selection.omissions.some((omission) => omission.id === "guide/install.md:9:1"),
      false,
      "required evidence is never named as omitted",
    );

    // The accounting splits the exact Markdown: bodies, provenance, and serialization overhead.
    const accounting = evidence.accounting;
    assert.equal(accounting.requested, 120);
    assert.equal(accounting.method, TOKEN_METHOD);
    assert.equal(accounting.margin, TOKEN_ERROR_MARGIN);
    assert.equal(accounting.upper, Math.ceil(accounting.used * (1 + TOKEN_ERROR_MARGIN)));
    assert.ok(accounting.selected > 0, "the selected bodies are priced");
    assert.ok(accounting.required > 0, "the required provenance lines are priced");
    assert.ok(accounting.overhead >= 0, "the title, headers, and separators are priced");
    assert.equal(accounting.selected + accounting.required + accounting.overhead, accounting.used);
    assert.equal(accounting.remaining, 120 - accounting.used);
    assert.ok(accounting.upper <= 120, "the hard budget is met");
    assert.equal(accounting.minimum, null);
    assert.deepEqual(evidence.warnings, []);

    // The Markdown and JSON are two renderings of one selection.
    const markdown = await runFile(root, value, []);
    assert.equal(markdown.code, 0, markdown.errors.join("\n"));
    assert.deepEqual(markdown.errors, []);
    const text = markdown.writes[0]!;
    assert.equal(estimateTokens(text).tokens, accounting.used, "the accounting prices the Markdown that was written");
    assert.ok(text.startsWith("# Context pack: install the engine\n\n"));
    for (const item of evidence.items) {
      assert.ok(text.includes(`## ${item.title}`), `Markdown names ${item.id}`);
      assert.ok(text.includes(`- URL: ${item.url}`), `Markdown shows ${item.id}'s URL`);
      assert.ok(text.includes(`- Source: \`${item.origin.source}\``), `Markdown shows ${item.id}'s source`);
      assert.ok(text.includes(item.content.trim()), `Markdown shows exactly ${item.id}'s content`);
    }
    assert.doesNotMatch(text, /## Upgrade the engine/, "an omitted page is absent from Markdown too");
    for (const omission of evidence.selection.omissions) {
      assert.doesNotMatch(text, new RegExp(`^## ${omission.text}$`, "m"), "an omitted section is absent too");
    }
    assert.match(text, /^## Steps$/m, "the required section is present in both forms");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an impossible hard budget keeps required evidence and publishes the over-budget minimum", async () => {
  const root = omissionSite();
  try {
    const value = request({
      include: ["guide/install.md"],
      budget: { maxTokens: 1 },
      requiredEvidence: { refs: ["guide/install.md:9:1"], source: true, versions: true },
    });
    const json = await runFile(root, value);
    assert.equal(json.code, 0, "an over-budget pack is still written and explained");
    assert.equal(json.writes.length, 1);
    assert.match(json.errors.join("\n"), /above the budget/);
    const evidence = JSON.parse(json.writes[0]!) as PackEvidence;

    // The failure is explicit: a stable warning id, a source span, and the smallest feasible cost.
    assert.ok(evidence.warnings.length > 0, "an impossible budget is diagnosed");
    const overBudgetIds = new Set([
      "pack.trim.over-budget",
      "pack.trim.required-over-budget",
      "context-pack.over-budget",
    ]);
    for (const warning of evidence.warnings) {
      assert.ok(overBudgetIds.has(warning.id), `warning ${warning.id} is an over-budget diagnosis`);
      assert.ok(warning.message.length > 0);
      assert.equal(typeof warning.span, "string");
    }
    assert.equal(evidence.warnings[0]!.id, "pack.trim.required-over-budget");
    const accounting = evidence.accounting;
    assert.ok(accounting.minimum !== null, "the smallest feasible serialization is published");
    assert.equal(accounting.minimum.tokens, accounting.used);
    assert.equal(accounting.minimum.upper, accounting.upper);
    assert.ok(accounting.minimum.upper > accounting.requested, "no feasible pack fits this budget");
    assert.ok(accounting.remaining < 0);
    assert.equal(accounting.margin, TOKEN_ERROR_MARGIN, "the margin is visible even when over budget");

    // Required evidence is never dropped: the pinned section and the provenance lines survive.
    const install = itemOf(evidence, "/guide/install/");
    assert.ok(
      install.sections.some((section) => section.id === "guide/install.md:9:1"),
      "the required section survives the impossible budget",
    );
    assert.match(install.content, /^## Steps$/m);
    assert.match(install.content, /^- Source span: `guide\/install\.md:/m);
    assert.match(install.content, /^- Version: current; locale: en$/m);

    // Every optional section that gave way is named as a budget omission, not silently lost.
    assert.deepEqual(
      evidence.selection.omissions.map((omission) => [omission.text, omission.reason]),
      [
        ["Requirements", "budget"],
        ["Troubleshooting", "budget"],
      ],
    );
    assert.equal(
      evidence.selection.omissions.some((omission) => omission.text === "Steps"),
      false,
      "the required section is not an omission",
    );

    const markdown = await runFile(root, value, []);
    assert.equal(markdown.code, 0);
    assert.equal(estimateTokens(markdown.writes[0]!).tokens, accounting.used);
    assert.match(markdown.writes[0]!, /^## Steps$/m, "both outputs keep the required section");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version bounds exclude other folders and a section ref without a section is missing evidence", async () => {
  const root = journeySite();
  try {
    const bounded = await runJson(
      root,
      request({
        task: { goal: "install the engine", kind: "migrate" },
        constraints: { locale: "en", version: { min: "v1", max: "v2" } },
      }),
    );
    assertFits(bounded, 6000, "version bounds");
    assert.ok(!bounded.items.some((item) => item.id.startsWith("/v3/")));
    assert.ok(bounded.items.every((item) => item.version !== "v3"));
    assert.ok(bounded.items.some((item) => item.version === "v1"));
    assert.ok(bounded.items.some((item) => item.version === "v2"));

    // A required page outside the allowed bound is refused explicitly, never silently selected.
    const blocked = await runFile(
      root,
      request({
        task: { goal: "install the engine" },
        constraints: { version: { min: "v1", max: "v2" } },
        requiredEvidence: { refs: ["/v3/guide/install/"] },
      }),
    );
    assert.equal(blocked.code, 1);
    assert.deepEqual(blocked.writes, []);
    assert.match(blocked.errors.join("\n"), /context-pack\.evidence-excluded/);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith(".mizzen-pack-")),
      [],
      "a refused request leaves no staging folder",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const sectionRoot = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  try {
    // Line 999 names no heading, so it is missing evidence; it never degrades to a whole-page match.
    const missing = await runFile(
      sectionRoot,
      request({
        include: ["guide/install.md"],
        requiredEvidence: { refs: ["guide/install.md:999:1"] },
      }),
    );
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.writes, [], "no pack is written for evidence that does not exist");
    assert.match(missing.errors.join("\n"), /context-pack\.missing-evidence/);

    // The same page with a real section line is satisfied.
    const found = await runFile(
      sectionRoot,
      request({
        include: ["guide/install.md"],
        requiredEvidence: { refs: ["guide/install.md:9:1"] },
      }),
    );
    assert.equal(found.code, 0, found.errors.join("\n"));
    const evidence = JSON.parse(found.writes[0]!) as PackEvidence;
    assert.ok(
      itemOf(evidence, "/guide/install/").sections.some((section) => section.id === "guide/install.md:9:1"),
    );
  } finally {
    rmSync(sectionRoot, { recursive: true, force: true });
  }
});

test("the same request on the same tree is byte-identical and --out writes the same bytes", async () => {
  const root = journeySite();
  try {
    const value = request({
      task: { goal: "install the engine", kind: "implement" },
      include: ["guide/install.md"],
      exclude: ["guide/deploy.md"],
      constraints: { locale: "en" },
      requiredEvidence: { refs: ["guide/install.md:9:1"], source: true, versions: true },
    });

    const firstJson = await runFile(root, value);
    const secondJson = await runFile(root, value);
    assert.equal(firstJson.code, 0);
    assert.equal(secondJson.code, 0);
    assert.deepEqual(secondJson.writes, firstJson.writes, "JSON bytes do not change between runs");
    assert.deepEqual(secondJson.errors, firstJson.errors);

    const firstMarkdown = await runFile(root, value, []);
    const secondMarkdown = await runFile(root, value, []);
    assert.equal(firstMarkdown.code, 0);
    assert.equal(secondMarkdown.code, 0);
    assert.deepEqual(secondMarkdown.writes, firstMarkdown.writes, "Markdown bytes do not change between runs");

    const out = join(root, "nested", "pack.json");
    const written = await runFile(root, value, ["--format", "json", "--out", out]);
    assert.equal(written.code, 0, written.errors.join("\n"));
    assert.deepEqual(written.writes, [], "--out leaves stdout empty");
    assert.deepEqual(written.errors, []);
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out, "utf8"), firstJson.writes[0], "--out writes exactly the stdout bytes");

    const markdownOut = join(root, "nested", "pack.md");
    const writtenMarkdown = await runFile(root, value, ["--out", markdownOut]);
    assert.equal(writtenMarkdown.code, 0);
    assert.deepEqual(writtenMarkdown.writes, []);
    assert.equal(readFileSync(markdownOut, "utf8"), firstMarkdown.writes[0]);

    assert.equal(
      readdirSync(join(root, "nested")).some((name) => name.startsWith(".mizzen-pack-")),
      false,
      "atomic writes leave no staging folder behind",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, oversized, and invalid requests are usage errors with clean stdout", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\n", "guide/install.md": INSTALL });
  try {
    // Malformed JSON on stdin.
    const malformedBuffers = capture(async () => "{not json");
    const malformed = await main(["pack", root, "--request", "-", "--format", "json"], malformedBuffers.io);
    assert.equal(malformed, 2);
    assert.deepEqual(malformedBuffers.writes, []);
    assert.match(malformedBuffers.errors.join("\n"), /not valid JSON/);

    // A valid JSON document that does not satisfy the request schema.
    const schema = await runFile(root, { version: 1, task: { goal: "install" } });
    assert.equal(schema.code, 2);
    assert.deepEqual(schema.writes, []);
    assert.match(schema.errors.join("\n"), /\/budget/);
    assert.match(schema.errors.join("\n"), /context-request\.missing/);

    // An unknown task kind is a schema error, named at its pointer with a stable code.
    const kind = await runFile(
      root,
      request({ task: { goal: "install the engine", kind: "ship" } }),
    );
    assert.equal(kind.code, 2);
    assert.deepEqual(kind.writes, []);
    assert.match(kind.errors.join("\n"), /\/task\/kind/);
    assert.match(kind.errors.join("\n"), /context-request\.enum/);

    // An oversized request is refused before parsing, with one size problem and no stdout.
    const oversized = join(root, "oversized.json");
    writeFileSync(
      oversized,
      JSON.stringify(
        request({ include: ["x".repeat(MAX_REQUEST_BYTES)] }),
      ),
    );
    assert.ok(readFileSync(oversized, "utf8").length > MAX_REQUEST_BYTES);
    const big = capture();
    assert.equal(await main(["pack", root, "--request", oversized, "--format", "json"], big.io), 2);
    assert.deepEqual(big.writes, []);
    assert.equal(big.errors.length, 1);
    assert.match(big.errors[0]!, /context-request\.too-large/);

    // Usage errors keep stdout clean too.
    const conflict = capture();
    assert.equal(await main(["pack", root, "--request", oversized, "--budget", "10"], conflict.io), 2);
    assert.deepEqual(conflict.writes, []);
    assert.match(conflict.errors.join("\n"), /--request and --budget cannot be used together/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
