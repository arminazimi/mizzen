import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import { trustReport, type TrustPageEntry } from "../src/outputs/trust.ts";

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

const POS = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in. */
function config(): SiteConfig {
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
  };
}

/** One doc page whose body starts on line 1. */
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

/** The report's page entries, keyed by URL. */
function pagesOf(file: OutputFile): Record<string, TrustPageEntry> {
  return bodyOf(file).pages as Record<string, TrustPageEntry>;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The page key the report is expected to write for a URL and source file. */
function pageKey(url: string, source = POS.file): string {
  return hash(`${url}\0${source}`);
}

/** A healthy model whose three signals all come from inline data. */
function healthy(): Site {
  return site([page("/guide/install/")], {
    examples: { pages: [{ url: "/guide/install/", total: 2, passed: 2, failed: 0, skipped: 0 }] },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada Lovelace" } },
  });
}

test("the report is version 2 and carries the threshold and explicit as-of instant", async () => {
  const file = await reportOf(healthy(), { asOf: "2026-10-10T00:00:00.000Z", thresholds: { reviewDueDays: 30 } });
  const body = bodyOf(file);

  assert.equal(body.version, 2);
  assert.equal(body.reviewDueDays, 30);
  assert.equal(body.asOf, "2026-10-10T00:00:00.000Z");
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
});

test("an absent as-of leaves the report without an instant and never reads the clock", async () => {
  const first = await reportOf(healthy());
  const second = await reportOf(healthy());
  const body = bodyOf(first);

  assert.equal("asOf" in body, false, "no wall clock is substituted");
  assert.equal(first.contents, second.contents, "two runs write the same bytes");
  assert.ok(String(first.contents).endsWith("}\n"), "one trailing LF");

  // The review date is known, but without an instant its age cannot be measured.
  const entry = pagesOf(first)["/guide/install/"]!;
  assert.equal(entry.evidence.review, "measured");
  assert.equal(entry.factors[2]!.code, "review.unknown");
  assert.equal(entry.level, "review-due");
});

test("each page exposes the scorer's ordered factors, consistent with its reasons and level", async () => {
  const entry = pagesOf(await reportOf(healthy(), { asOf: "2026-10-10T00:00:00.000Z" }))["/guide/install/"]!;

  assert.deepEqual(
    entry.factors.map((factor) => factor.signal),
    ["examples", "drift", "review"],
  );
  assert.deepEqual(
    entry.factors.map((factor) => factor.code),
    entry.reasons.map((reason) => reason.code),
    "every factor carries the same code as its reason",
  );
  assert.deepEqual(entry.factors, [
    { signal: "examples", code: "examples.passed", state: "positive", value: 0 },
    { signal: "drift", code: "drift.clean", state: "positive", value: 0 },
    { signal: "review", code: "review.recent", state: "positive", value: 9 },
  ]);
  assert.equal(entry.level, "verified");
});

test("a failing example is a negative factor and at-risk, never verified", async () => {
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 1, failed: 1 } },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada" } },
  });

  const entry = pagesOf(await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" }))["/guide/install/"]!;
  assert.deepEqual(entry.factors[0], { signal: "examples", code: "examples.failed", state: "negative", value: 1 });
  assert.equal(entry.reasons[0]!.code, "examples.failed");
  assert.equal(entry.level, "at-risk");
});

test("inline data, a computed drift pass, and a git review name their own source and input", { skip: !hasGit() }, async () => {
  const root = repository([
    { path: "guide/install.md", date: "2026-10-01T00:00:00Z", author: "Ada Lovelace", text: "# Install\n" },
  ]);
  try {
    const model = site([page("/guide/install/")], {
      examples: { "/guide/install/": { passed: 2, failed: 0 } },
    });
    const entry = pagesOf(await reportOf(model, { root, asOf: "2026-10-10T00:00:00.000Z" }))["/guide/install/"]!;

    assert.deepEqual(entry.provenance, {
      examples: { source: "inline", availability: "available", input: "/guide/install/" },
      drift: { source: "computed", availability: "available", input: "guide/install.md" },
      review: { source: "git", availability: "available", input: "guide/install.md" },
    });
    assert.deepEqual(entry.evidence, { examples: "measured", drift: "measured", review: "measured" });
    assert.equal(entry.reviewCoverage, "recorded");
    assert.equal(entry.lastReviewer, "Ada Lovelace");
    assert.equal(entry.level, "verified");
    assert.equal(validate(bodyOf(await reportOf(model, { root, asOf: "2026-10-10T00:00:00.000Z" }))), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inline drift keeps the inline channel instead of claiming a computed pass", async () => {
  const entry = pagesOf(await reportOf(healthy(), { asOf: "2026-10-10T00:00:00.000Z" }))["/guide/install/"]!;

  assert.deepEqual(entry.provenance.drift, {
    source: "inline",
    availability: "available",
    input: "/guide/install/",
  });
});

test("untracked files and a missing git history are distinct review states", { skip: !hasGit() }, async () => {
  const repo = repository([{ path: "README.md", date: "2026-10-01T00:00:00Z", text: "# Site\n" }]);
  const plain = mkdtempSync(join(tmpdir(), "trust-provenance-plain-"));
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 2, failed: 0 } },
    drift: { "/guide/install/": 0 },
  });
  try {
    write(plain, "guide/install.md", "# Install\n");

    const untracked = pagesOf(await reportOf(model, { root: repo, asOf: "2026-10-10T00:00:00.000Z" }))[
      "/guide/install/"
    ]!;
    const unavailable = pagesOf(await reportOf(model, { root: plain, asOf: "2026-10-10T00:00:00.000Z" }))[
      "/guide/install/"
    ]!;

    assert.equal(untracked.reviewCoverage, "untracked");
    assert.deepEqual(untracked.provenance.review, {
      source: "git",
      availability: "unavailable",
      input: "guide/install.md",
    });
    assert.equal(untracked.evidence.review, "unknown");
    assert.equal(untracked.factors[2]!.code, "review.unknown");
    assert.equal(untracked.level, "review-due");

    assert.equal(unavailable.reviewCoverage, "unavailable");
    assert.deepEqual(unavailable.provenance.review, {
      source: "git",
      availability: "unavailable",
      input: "guide/install.md",
    });
    assert.equal(unavailable.evidence.review, "unknown");
    assert.equal(unavailable.level, "review-due");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("malformed inline data is unavailable, never measured and never missing", async () => {
  const model = site([page("/guide/run/")], {
    examples: { "/guide/run/": "many" },
    drift: { "/guide/run/": "many" },
    reviewers: { "/guide/run/": { date: "not-a-date", author: "Ada" } },
  });

  const file = await reportOf(model);
  const entry = pagesOf(file)["/guide/run/"]!;

  assert.deepEqual(entry.evidence, { examples: "unknown", drift: "unknown", review: "unknown" });
  assert.deepEqual(entry.provenance, {
    examples: { source: "inline", availability: "unavailable", input: "/guide/run/" },
    drift: { source: "inline", availability: "unavailable", input: "/guide/run/" },
    review: { source: "inline", availability: "unavailable", input: "/guide/run/" },
  });
  assert.deepEqual(
    entry.factors.map((factor) => factor.code),
    ["examples.unknown", "drift.unknown", "review.unknown"],
  );
  assert.equal(entry.level, "at-risk", "no unknown signal can be read as verified");
  assert.equal(validate(bodyOf(file)), true, JSON.stringify(validate.errors));
});

test("invalid inline drift and review never fall back to a computed pass or git", { skip: !hasGit() }, async () => {
  const root = repository([
    { path: "guide/install.md", date: "2026-10-01T00:00:00Z", author: "Ada Lovelace", text: "# Install\n" },
  ]);
  try {
    // A root is active: computed drift would succeed with 0 and git would find a recent review.
    const model = site([page("/guide/install/")], {
      drift: { "/guide/install/": "many" },
      reviewers: { "/guide/install/": { date: "not-a-date", author: "Ada" } },
    });
    const entry = pagesOf(await reportOf(model, { root, asOf: "2026-10-10T00:00:00.000Z" }))[
      "/guide/install/"
    ]!;

    assert.deepEqual(entry.provenance.drift, {
      source: "inline",
      availability: "unavailable",
      input: "/guide/install/",
    });
    assert.deepEqual(entry.provenance.review, {
      source: "inline",
      availability: "unavailable",
      input: "/guide/install/",
    });
    assert.equal(entry.evidence.drift, "unknown", "invalid inline drift is unknown, not a computed zero");
    assert.equal(entry.evidence.review, "unknown", "invalid inline review is unknown, not a git date");
    assert.equal(entry.reviewCoverage, "unknown");
    assert.equal(entry.level, "at-risk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no examples is not-applicable, while absent drift and review sources are missing", async () => {
  const entry = pagesOf(await reportOf(site([page("/guide/plain/")])))["/guide/plain/"]!;

  assert.deepEqual(entry.evidence, { examples: "none", drift: "missing", review: "missing" });
  assert.deepEqual(entry.provenance, {
    examples: { source: "none", availability: "not-applicable" },
    drift: { source: "none", availability: "missing" },
    review: { source: "none", availability: "missing" },
  });
  assert.equal(entry.factors[0]!.state, "neutral");
  assert.equal(entry.reviewCoverage, "unknown");
});

test("a page that declares examples but has no data is unknown and at-risk", async () => {
  const markdown = ["```ts test", 'console.log("hi");', "```", ""].join("\n");
  const entry = pagesOf(await reportOf(site([page("/guide/run/", markdown)])))["/guide/run/"]!;

  assert.equal(entry.evidence.examples, "unknown");
  assert.deepEqual(entry.provenance.examples, { source: "none", availability: "missing" });
  assert.deepEqual(entry.factors[0], {
    signal: "examples",
    code: "examples.unknown",
    state: "missing",
    value: "unknown",
  });
  assert.equal(entry.level, "at-risk");
});

test("conflicting review evidence is a conflict, not a fresh review", async () => {
  const model = site([page("/guide/install/")], {
    examples: { "/guide/install/": { passed: 2, failed: 0 } },
    drift: { "/guide/install/": 0 },
    reviewers: { "/guide/install/": { date: "2026-10-10T00:00:00.000Z", author: "Ada" } },
  });

  const entry = pagesOf(await reportOf(model, { asOf: "2026-10-01T00:00:00.000Z" }))["/guide/install/"]!;

  assert.deepEqual(entry.factors[2], { signal: "review", code: "review.conflict", state: "conflict", value: -9 });
  assert.equal(entry.reasons[2]!.code, "review.conflict");
  assert.equal(entry.provenance.review.availability, "conflict");
  assert.equal(entry.level, "review-due");
});

test("page keys and the build identity keep their old rules", async () => {
  const model = site([page("/b/"), page("/a/", "# A\n", "a.md")], { drift: { "/a/": 0, "/b/": 0 } });
  const body = bodyOf(await reportOf(model, { asOf: "2026-10-10T00:00:00.000Z" }));
  const pages = body.pages as Record<string, TrustPageEntry>;

  assert.equal(pages["/a/"]!.key, pageKey("/a/", "a.md"));
  assert.equal(pages["/b/"]!.key, pageKey("/b/"));
  assert.equal(
    (body.build as Record<string, unknown>).id,
    hash(
      [page("/a/", "# A\n", "a.md"), page("/b/")]
        .map((entry) => `${pageKey(entry.url, entry.source.file)}\0${hash(entry.markdown)}\0${hash(entry.html)}\n`)
        .join(""),
    ),
  );
  assert.deepEqual(Object.keys(pages), ["/a/", "/b/"]);
});

test("the schema accepts the emitted report and rejects malformed factors and provenance", async () => {
  const body = bodyOf(await reportOf(healthy(), { asOf: "2026-10-10T00:00:00.000Z" }));
  const entryOf = (): Record<string, unknown> =>
    structuredClone((body.pages as Record<string, Record<string, unknown>>)["/guide/install/"]!);

  assert.equal(validate(body), true, JSON.stringify(validate.errors));

  const changed = (mutate: (entry: Record<string, unknown>) => void): boolean => {
    const entry = entryOf();
    mutate(entry);
    return validate({ ...body, pages: { "/guide/install/": entry } });
  };

  assert.equal(changed((entry) => delete entry.factors), false, "factors are required");
  assert.equal(changed((entry) => delete entry.provenance), false, "provenance is required");
  assert.equal(changed((entry) => delete entry.reviewCoverage), false, "reviewCoverage is required");
  assert.equal(validate({ ...body, version: 3 }), false, "the version is fixed");
  const withoutThreshold = structuredClone(body);
  delete withoutThreshold.reviewDueDays;
  assert.equal(validate(withoutThreshold), false, "the threshold is required");
  assert.equal(
    changed((entry) => {
      (entry.provenance as Record<string, Record<string, unknown>>).review!.source = "computed";
    }),
    false,
    "a review cannot come from a computed pass",
  );
  assert.equal(
    changed((entry) => {
      (entry.provenance as Record<string, Record<string, unknown>>).review!.availability = "maybe";
    }),
    false,
    "an unknown availability is rejected",
  );
  assert.equal(
    changed((entry) => {
      (entry.factors as Array<Record<string, unknown>>)[0]!.value = 1.5;
    }),
    false,
    "a factor value is a whole number or unknown",
  );
  assert.equal(
    changed((entry) => {
      (entry.factors as Array<Record<string, unknown>>)[0]!.state = "great";
    }),
    false,
    "an unknown factor state is rejected",
  );
  assert.equal(
    changed((entry) => {
      entry.reviewCoverage = "gone";
    }),
    false,
    "an unknown coverage is rejected",
  );

  // The conflict codes the scorer can emit are part of the schema.
  const conflicted = entryOf();
  conflicted.level = "review-due";
  conflicted.reasons = [
    { code: "examples.none", message: "none" },
    { code: "drift.clean", message: "clean" },
    { code: "review.conflict", message: "conflict" },
  ];
  conflicted.factors = [
    { signal: "examples", code: "examples.none", state: "neutral", value: "unknown" },
    { signal: "drift", code: "drift.clean", state: "positive", value: 0 },
    { signal: "review", code: "review.conflict", state: "conflict", value: -9 },
  ];
  (conflicted.provenance as Record<string, Record<string, unknown>>).review!.availability = "conflict";
  assert.equal(validate({ ...body, pages: { "/guide/install/": conflicted } }), true, JSON.stringify(validate.errors));
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
  const root = mkdtempSync(join(tmpdir(), "trust-provenance-git-"));
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
