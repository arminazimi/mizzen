import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import { trust, trustAsOf, trustEntryOf, trustReport, trustRoot } from "../src/outputs/trust.ts";
import { build } from "../src/pipeline/build.ts";

type Schema = {
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

const schema = JSON.parse(readFileSync(new URL("../schema/trust.schema.json", import.meta.url), "utf8")) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const POS = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

/** One doc page whose body starts on line 1, with the given source file. */
function page(url: string, markdown = "# Page\n", file = POS.file): Page {
  return {
    url,
    source: { ...POS, file },
    frontMatter: {},
    title: url,
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

/** The single `trust.json` file the report writes. */
async function reportOf(model: Site, options: Parameters<typeof trustReport>[1] = {}): Promise<OutputFile> {
  const files = await trustReport(model, options);
  assert.equal(files.length, 1, "the report writes one file");
  return files[0]!;
}

function bodyOf(file: OutputFile): Record<string, unknown> {
  return JSON.parse(String(file.contents)) as Record<string, unknown>;
}

test("the output is named after its file", () => {
  assert.equal(trust.name, "trust");
});

test("a clean page with fresh examples, no drift, and a recent review is verified", async () => {
  const model = site([page("/guide/install/")], {
    examples: { pages: [{ url: "/guide/install/", total: 2, passed: 2, failed: 0, skipped: 0 }] },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada Lovelace" } },
  });

  const file = await reportOf(model, { asOf: "2026-10-10T00:00:00.000Z" });
  assert.deepEqual(bodyOf(file), {
    "/guide/install/": {
      level: "verified",
      reasons: [
        { code: "examples.passed", message: "No example fails; 2 of 2 pass." },
        { code: "drift.clean", message: "No drift findings." },
        { code: "review.recent", message: "Last reviewed 9 days ago, within the 180-day limit." },
      ],
      lastReviewer: "Ada Lovelace",
    },
  });
  assert.equal(validate(bodyOf(file)), true, JSON.stringify(validate.errors));
});

test("a failing example makes the page at-risk whatever the other signals say", async () => {
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 1, failed: 1 } },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada" } },
  });

  const entry = bodyOf(await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" }))["/guide/install/"] as Record<string, unknown>;
  assert.equal(entry.level, "at-risk");
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[0], {
    code: "examples.failed",
    message: "1 of 2 examples fail.",
  });
});

test("a drift finding makes the page at-risk", async () => {
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 2, failed: 0 } },
    drift: { "/guide/install/": 2 },
    reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada" } },
  });

  const entry = bodyOf(await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" }))["/guide/install/"] as Record<string, unknown>;
  assert.equal(entry.level, "at-risk");
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[1], {
    code: "drift.findings",
    message: "2 drift findings: the page no longer matches the code it cites.",
  });
});

test("a review older than 180 days makes the page review-due", async () => {
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 2, failed: 0 } },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-01-01T00:00:00.000Z", author: "Ada" } },
  });

  const entry = bodyOf(await reportOf(model, { asOf: "2026-07-01T00:00:00.000Z" }))["/guide/install/"] as Record<string, unknown>;
  assert.equal(entry.level, "review-due");
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[2], {
    code: "review.overdue",
    message: "Last reviewed 181 days ago, past the 180-day limit.",
  });
});

test("unknown inputs write unknown reasons and never claim verified", async () => {
  const markdown = ["```ts test", 'console.log("hi");', "```", ""].join("\n");
  const file = await reportOf(site([page("/guide/run/", markdown)]));

  assert.deepEqual(bodyOf(file), {
    "/guide/run/": {
      level: "at-risk",
      reasons: [
        {
          code: "examples.unknown",
          message: "The example results are unknown, so the page cannot be verified.",
        },
        { code: "drift.unknown", message: "Drift was not checked, so the page cannot be verified." },
        {
          code: "review.unknown",
          message: "The review age is unknown, so the page cannot be confirmed as reviewed.",
        },
      ],
    },
  });
  assert.equal(validate(bodyOf(file)), true, JSON.stringify(validate.errors));
});

test("a page that declares no examples keeps the neutral examples.none reason", async () => {
  const file = await reportOf(site([page("/guide/plain/")]));
  const entry = bodyOf(file)["/guide/plain/"] as Record<string, unknown>;
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[0], {
    code: "examples.none",
    message: "The page declares no runnable examples.",
  });
});

test("URLs are sorted and the bytes are fixed: key order, two spaces, LF", async () => {
  const model = site([page("/b/"), page("/a/")], {
    drift: { "/a/": 0, "/b/": 0 },
    reviewers: {
      "/a/": { date: "2026-10-01T00:00:00.000Z", author: "Ada Lovelace" },
      "/b/": { date: "2026-10-01T00:00:00.000Z", author: "Ada Lovelace" },
    },
  });

  const first = await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" });
  const second = await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" });
  assert.equal(first.contents, second.contents, "two runs write the same bytes");

  const entry = (url: string): string[] => [
    `  ${JSON.stringify(url)}: {`,
    '    "level": "verified",',
    '    "reasons": [',
    "      {",
    '        "code": "examples.none",',
    '        "message": "The page declares no runnable examples."',
    "      },",
    "      {",
    '        "code": "drift.clean",',
    '        "message": "No drift findings."',
    "      },",
    "      {",
    '        "code": "review.recent",',
    '        "message": "Last reviewed 1 day ago, within the 180-day limit."',
    "      }",
    "    ],",
    '    "lastReviewer": "Ada Lovelace"',
    "  }",
  ];

  assert.equal(
    String(first.contents),
    ["{", `${entry("/a/").join("\n")},`, entry("/b/").join("\n"), "}", ""].join("\n"),
  );
});

test("the schema rejects an entry with no reasons or an unknown code", () => {
  assert.equal(validate({ "/a/": { level: "verified", reasons: [] } }), false);
  assert.equal(
    validate({
      "/a/": {
        level: "verified",
        reasons: [{ code: "made.up", message: "no" }],
      },
    }),
    false,
  );
});

test("root makes drift and review real: a missing citation is a finding and git names the reviewer", { skip: !hasGit() }, async () => {
  const root = repository([
    { path: "guide/install.md", date: "2026-10-01T00:00:00Z", author: "Ada Lovelace", text: "# Install\n" },
  ]);
  try {
    const model = site([page("/guide/install/")], {
      examples: { "/guide/install/": { passed: 2, failed: 0 } },
    });
    const file = await reportOf(model, { root, asOf: "2026-10-10T00:00:00.000Z" });
    const entry = bodyOf(file)["/guide/install/"] as Record<string, unknown>;
    assert.equal(entry.level, "verified");
    assert.equal(entry.lastReviewer, "Ada Lovelace");
    assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[2], {
      code: "review.recent",
      message: "Last reviewed 9 days ago, within the 180-day limit.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root compares claims: a reference to a missing file is a drift finding", async () => {
  const root = mkdtempSync(join(tmpdir(), "trust-drift-"));
  try {
    write(root, "src/build.ts", "export function buildDocs() {\n  return 1;\n}\n");
    const model = site([page("/guide/setup/", "The old guide points at src/gone.ts:3.\n", "guide/setup.md")], {
      examples: { "/guide/setup/": { passed: 1, failed: 0 } },
    });
    const file = await reportOf(model, { root });
    const entry = bodyOf(file)["/guide/setup/"] as Record<string, unknown>;
    assert.equal(entry.level, "at-risk");
    assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[1], {
      code: "drift.findings",
      message: "1 drift finding: the page no longer matches the code it cites.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pure entry builder adds examples.unknown and at-risk for an unmeasured page", () => {
  const entry = trustEntryOf(
    {
      examples: "unknown",
      drift: 0,
      review: { date: "2026-10-01T00:00:00.000Z", author: "Ada" },
      asOf: new Date("2026-10-02T00:00:00.000Z"),
    },
    {},
  );
  assert.equal(entry.level, "at-risk");
  assert.deepEqual(entry.reasons.map((reason) => reason.code), ["examples.unknown", "drift.clean", "review.recent"]);
  assert.equal(entry.lastReviewer, "Ada");
});

test("the root and asOf environment variables are read without the clock", () => {
  assert.equal(trustRoot({ MIZZEN_SITE_ROOT: "/tmp/site" }), "/tmp/site");
  assert.equal(trustRoot({ MIZZEN_SITE_ROOT: "  " }), process.cwd());
  assert.equal(trustRoot({}), process.cwd());

  assert.equal(trustAsOf({ SOURCE_DATE_EPOCH: "1767225600" })?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(trustAsOf({ SOURCE_DATE_EPOCH: "later" }), undefined);
  assert.equal(trustAsOf({ SOURCE_DATE_EPOCH: "-1" }), undefined);
  assert.equal(trustAsOf({}), undefined);
});

/** True when git is installed, so the commit tests can run. */
function hasGit(): boolean {
  return !spawnSync("git", ["--version"]).error;
}

/** One commit: a file, its text, and who wrote it when. */
interface Commit {
  readonly path: string;
  readonly date: string;
  readonly author?: string;
  readonly text?: string;
}

/** Writes and commits one file in `root`. */
function commitAt(root: string, commit: Commit): void {
  const path = join(root, commit.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, commit.text ?? `# ${commit.path}\n`);
  execFileSync("git", ["add", "--", commit.path], { cwd: root });
  const author = commit.author ?? "Review Test";
  execFileSync("git", ["commit", "-q", "-m", commit.path], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: "review@example.com",
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: "review@example.com",
      GIT_COMMITTER_DATE: commit.date,
    },
  });
}

/** A temporary git repository with `commits` made in order; the caller removes it. */
function repository(commits: readonly Commit[]): string {
  const root = mkdtempSync(join(tmpdir(), "trust-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "review@example.com"], { cwd: root });
  for (const commit of commits) commitAt(root, commit);
  return root;
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A temporary site tree. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "trust-site-"));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

/** A fresh output folder whose parent the caller removes. */
function outFolder(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "trust-out-"));
  return { parent, out: join(parent, "site") };
}

test("the output runs by default and outputs: { trust: false } switches it off", async () => {
  const onRoot = tree({ "a.md": "---\ntitle: A\n---\n# A\n" });
  const offRoot = tree({ "mizzen.yml": "outputs:\n  trust: false\n", "a.md": "---\ntitle: A\n---\n# A\n" });
  const on = outFolder();
  const off = outFolder();
  const previousRoot = process.env.MIZZEN_SITE_ROOT;
  const previousEpoch = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.MIZZEN_SITE_ROOT = onRoot;
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    const built = await build({ root: onRoot, out: on.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.ok(built.files.includes("trust.json"), "the output is on by default");
    const body = JSON.parse(readFileSync(join(on.out, "trust.json"), "utf8")) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(body), ["/a/"]);
    assert.equal(body["/a/"]?.level, "review-due");
    assert.equal(validate(body), true, JSON.stringify(validate.errors));

    const switched = await build({ root: offRoot, out: off.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.equal(switched.files.includes("trust.json"), false, "the switched-off output writes nothing");
  } finally {
    if (previousRoot === undefined) delete process.env.MIZZEN_SITE_ROOT;
    else process.env.MIZZEN_SITE_ROOT = previousRoot;
    if (previousEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previousEpoch;
    rmSync(onRoot, { recursive: true, force: true });
    rmSync(offRoot, { recursive: true, force: true });
    rmSync(on.parent, { recursive: true, force: true });
    rmSync(off.parent, { recursive: true, force: true });
  }
});
