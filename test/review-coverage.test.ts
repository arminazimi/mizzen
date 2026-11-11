import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputFile } from "../src/contracts/output.ts";
import { DEFAULT_REVIEW_POLICY, policyFor, resolveReviewPolicy, reviewPolicyValue } from "../src/model/review-policy.ts";
import { reviewCoverage, reviewCoverageReport } from "../src/outputs/review-coverage.ts";
import { build } from "../src/pipeline/build.ts";

type Schema = {
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

const schema = JSON.parse(
  readFileSync(new URL("../schema/review-coverage.schema.json", import.meta.url), "utf8"),
) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const POS = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

const AS_OF = "2026-11-11T00:00:00.000Z";
const DAY = 86_400_000;

/** An ISO instant a whole number of days before the fixed as-of. */
function daysBefore(days: number): string {
  return new Date(Date.parse(AS_OF) - days * DAY).toISOString();
}

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

/** One page whose body starts on line 1, with the given source file. */
function page(url: string, file = POS.file): Page {
  return {
    url,
    source: { ...POS, file },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "# Page\n",
    kind: "doc",
  };
}

function site(pages: readonly Page[], data: Readonly<Record<string, unknown>> = {}): Site {
  return { config: config(), pages, nav: {}, data };
}

/** The single `review-coverage.json` file the report writes. */
async function reportOf(model: Site, options: Parameters<typeof reviewCoverageReport>[1] = {}): Promise<OutputFile> {
  const files = await reviewCoverageReport(model, options);
  assert.equal(files.length, 1, "the report writes one file");
  return files[0]!;
}

function bodyOf(file: OutputFile): Record<string, unknown> {
  return JSON.parse(String(file.contents)) as Record<string, unknown>;
}

/** The report's page entries, keyed by URL. */
function pagesOf(file: OutputFile): Record<string, Record<string, unknown>> {
  return bodyOf(file).pages as Record<string, Record<string, unknown>>;
}

/** True when git is installed, so the commit tests can run. */
function hasGit(): boolean {
  return !spawnSync("git", ["--version"]).error;
}

/** One commit: a file, its text, and who wrote it when. */
interface Commit {
  readonly path: string;
  /** The committer date, as `GIT_COMMITTER_DATE` reads it. */
  readonly date: string;
  readonly author?: string;
  readonly email?: string;
  /** The file's text; by default a heading naming the path and date. */
  readonly text?: string;
}

/** Writes and commits one file in `root`. */
function commitAt(root: string, commit: Commit): void {
  const path = join(root, commit.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, commit.text ?? `# ${commit.path}\n\n${commit.date}\n`);
  execFileSync("git", ["add", "--", commit.path], { cwd: root });
  const author = commit.author ?? "Review Test";
  const email = commit.email ?? "review@example.com";
  execFileSync("git", ["commit", "-q", "-m", commit.path], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: commit.date,
    },
  });
}

/** A temporary git repository with `commits` made in order; the caller removes it. */
function repository(commits: readonly Commit[]): string {
  const root = mkdtempSync(join(tmpdir(), "review-coverage-git-"));
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
  const root = mkdtempSync(join(tmpdir(), "review-coverage-site-"));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

/** A fresh output folder whose parent the caller removes. */
function outFolder(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "review-coverage-out-"));
  return { parent, out: join(parent, "site") };
}

/** The reason codes of a resolution, in order, for compact assertions. */
function codesOf(diagnostics: readonly { code: string }[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

test("the policy resolver applies the most specific rule and leaves other paths on the default", () => {
  const resolved = resolveReviewPolicy({
    default: { windowDays: 180, minReviewers: 1 },
    rules: [
      { path: "guide", windowDays: 90 },
      { path: "guide/security", minReviewers: 2 },
      { path: "guide/security", windowDays: 7, minReviewers: 3 },
    ],
  });

  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.default, { windowDays: 180, minReviewers: 1 });
  assert.deepEqual(resolved.rules, [
    { path: "guide", windowDays: 90, minReviewers: 1 },
    { path: "guide/security", windowDays: 180, minReviewers: 2 },
    { path: "guide/security", windowDays: 7, minReviewers: 3 },
  ]);

  assert.deepEqual(policyFor(resolved, "guide/security/keys.md"), {
    windowDays: 7,
    minReviewers: 3,
    path: "guide/security",
  });
  assert.deepEqual(policyFor(resolved, "guide/install.md"), {
    windowDays: 90,
    minReviewers: 1,
    path: "guide",
  });
  assert.deepEqual(policyFor(resolved, "guidebook.md"), {
    windowDays: 180,
    minReviewers: 1,
    path: null,
  });
  assert.deepEqual(policyFor(resolved, "other.md"), {
    windowDays: 180,
    minReviewers: 1,
    path: null,
  });
});

test("the default accepts top-level fields, numeric strings, and a folder glob", () => {
  const resolved = resolveReviewPolicy({
    windowDays: "90",
    minReviewers: "2",
    rules: [{ path: "security/**", windowDays: 7 }],
  });

  assert.deepEqual(resolved.default, { windowDays: 90, minReviewers: 2 });
  assert.deepEqual(resolved.rules, [{ path: "security", windowDays: 7, minReviewers: 2 }]);
  assert.deepEqual(policyFor(resolved, "security/keys.md"), {
    windowDays: 7,
    minReviewers: 2,
    path: "security",
  });
});

test("invalid rules are diagnosed and omitted, and an invalid default field falls back", () => {
  const resolved = resolveReviewPolicy({
    windowDays: 0,
    minReviewers: "3",
    rules: [
      "not a rule",
      { path: "", windowDays: 30, minReviewers: 1 },
      { path: "/absolute", windowDays: 30, minReviewers: 1 },
      { path: "../escape", windowDays: 30, minReviewers: 1 },
      { path: "a/*/b", windowDays: 30, minReviewers: 1 },
      { path: "ok", windowDays: 1.5, minReviewers: 1 },
      { path: "ok", windowDays: 30, minReviewers: 0 },
      { path: "ok", windowDays: 30, minReviewers: 2 },
    ],
  });

  assert.deepEqual(resolved.default, { windowDays: 180, minReviewers: 3 });
  assert.deepEqual(resolved.rules, [{ path: "ok", windowDays: 30, minReviewers: 2 }]);
  assert.deepEqual(codesOf(resolved.diagnostics), [
    "review-policy.invalid-default",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
    "review-policy.invalid-rule",
  ]);
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => diagnostic.rule),
    [undefined, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.match(resolved.diagnostics[0]!.message, /windowDays/);
  assert.match(resolved.diagnostics[1]!.message, /rule 1/);
});

test("a non-mapping policy and a non-list rules value are diagnosed, never trusted", () => {
  const notMapping = resolveReviewPolicy("nope");
  assert.deepEqual(notMapping.default, DEFAULT_REVIEW_POLICY);
  assert.deepEqual(notMapping.rules, []);
  assert.deepEqual(codesOf(notMapping.diagnostics), ["review-policy.invalid"]);

  const notRules = resolveReviewPolicy({ rules: "nope" });
  assert.deepEqual(codesOf(notRules.diagnostics), ["review-policy.invalid-rules"]);
  assert.deepEqual(notRules.rules, []);
});

test("the hyphenated data key wins over the camelCase alias", () => {
  assert.deepEqual(reviewPolicyValue({ "review-policy": { windowDays: 1 }, reviewPolicy: { windowDays: 2 } }), {
    windowDays: 1,
  });
  assert.deepEqual(reviewPolicyValue({ reviewPolicy: { windowDays: 2 } }), { windowDays: 2 });
});

test("the output is named after its file", () => {
  assert.equal(reviewCoverage.name, "review-coverage");
});

test("the report distinguishes satisfied, insufficient, overdue, untracked, and unavailable", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const root = repository([
    { path: "guide/recent.md", date: daysBefore(10), author: "Ada Lovelace" },
    { path: "guide/team.md", date: daysBefore(20), author: "Ada Lovelace" },
    { path: "guide/team.md", date: daysBefore(5), author: "Grace Hopper" },
    { path: "guide/one.md", date: daysBefore(20), author: "Ada Lovelace" },
    { path: "guide/one.md", date: daysBefore(5), author: "Ada Lovelace" },
    { path: "guide/old.md", date: daysBefore(100), author: "Ada Lovelace" },
  ]);

  try {
    write(root, "guide/untracked.md", "# Untracked\n");
    const model = site(
      [
        page("/guide/recent/", "guide/recent.md"),
        page("/guide/team/", "guide/team.md"),
        page("/guide/one/", "guide/one.md"),
        page("/guide/old/", "guide/old.md"),
        page("/guide/untracked/", "guide/untracked.md"),
      ],
      {
        "review-policy": {
          windowDays: 30,
          minReviewers: 1,
          rules: [{ path: "guide/one.md", windowDays: 30, minReviewers: 2 }],
        },
      },
    );

    const file = await reportOf(model, { root, asOf: AS_OF });
    assert.equal(validate(bodyOf(file)), true, JSON.stringify(validate.errors));
    const pages = pagesOf(file);

    assert.equal(pages["/guide/recent/"]!.state, "satisfied");
    assert.deepEqual(pages["/guide/recent/"]!.policy, {
      windowDays: 30,
      minReviewers: 1,
      path: null,
    });
    assert.deepEqual(pages["/guide/recent/"]!.reviewers, ["Ada Lovelace"]);
    assert.deepEqual(pages["/guide/recent/"]!.commits, [{ date: daysBefore(10), author: "Ada Lovelace" }]);
    assert.deepEqual(pages["/guide/recent/"]!.lastReview, { date: daysBefore(10), author: "Ada Lovelace" });

    assert.equal(pages["/guide/team/"]!.state, "satisfied");
    assert.deepEqual(pages["/guide/team/"]!.reviewers, ["Ada Lovelace", "Grace Hopper"]);
    assert.deepEqual(pages["/guide/team/"]!.commits, [
      { date: daysBefore(5), author: "Grace Hopper" },
      { date: daysBefore(20), author: "Ada Lovelace" },
    ]);

    // The sensitive rule asks for two reviewers; this file has two commits from one person.
    assert.equal(pages["/guide/one/"]!.state, "insufficient");
    assert.deepEqual(pages["/guide/one/"]!.policy, {
      windowDays: 30,
      minReviewers: 2,
      path: "guide/one.md",
    });
    assert.deepEqual(pages["/guide/one/"]!.reviewers, ["Ada Lovelace"]);
    assert.equal((pages["/guide/one/"]!.commits as unknown[]).length, 2);

    // The sensitive rule did not change the other pages' fresh, one-reviewer policy.
    assert.equal(pages["/guide/team/"]!.state, "satisfied");

    assert.equal(pages["/guide/old/"]!.state, "overdue");
    assert.deepEqual(pages["/guide/old/"]!.reviewers, []);
    assert.deepEqual(pages["/guide/old/"]!.commits, []);
    assert.deepEqual(pages["/guide/old/"]!.lastReview, { date: daysBefore(100), author: "Ada Lovelace" });

    assert.equal(pages["/guide/untracked/"]!.state, "untracked");
    assert.deepEqual(pages["/guide/untracked/"]!.reviewers, []);
    assert.deepEqual(pages["/guide/untracked/"]!.commits, []);
    assert.equal("lastReview" in pages["/guide/untracked/"]!, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plain folder is unavailable and a missing as-of is no-as-of", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const plain = mkdtempSync(join(tmpdir(), "review-coverage-plain-"));
  const root = repository([{ path: "guide/recent.md", date: daysBefore(10), author: "Ada Lovelace" }]);
  try {
    write(plain, "guide/install.md", "# Install\n");
    const plainEntry = pagesOf(
      await reportOf(site([page("/guide/install/", "guide/install.md")]), { root: plain, asOf: AS_OF }),
    )["/guide/install/"]!;
    assert.equal(plainEntry.state, "unavailable");
    assert.deepEqual(plainEntry.reviewers, []);
    assert.deepEqual(plainEntry.commits, []);
    assert.equal("lastReview" in plainEntry, false);

    const noAsOf = await reportOf(site([page("/guide/recent/", "guide/recent.md")]), { root });
    const body = bodyOf(noAsOf);
    assert.equal(body.asOf, null);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    const entry = pagesOf(noAsOf)["/guide/recent/"]!;
    assert.equal(entry.state, "no-as-of");
    assert.deepEqual(entry.reviewers, []);
    assert.deepEqual(entry.commits, []);
    assert.equal("lastReview" in entry, false);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page source outside the root is unavailable, never another file's history", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const root = repository([{ path: "escape.md", date: daysBefore(10), author: "Outside" }]);
  try {
    const siteRoot = join(root, "site");
    mkdirSync(siteRoot, { recursive: true });
    const entry = pagesOf(
      await reportOf(site([page("/escape/", "../escape.md")]), { root: siteRoot, asOf: AS_OF }),
    )["/escape/"]!;

    assert.equal(entry.state, "unavailable");
    assert.deepEqual(entry.reviewers, []);
    assert.deepEqual(entry.commits, []);
    assert.equal("lastReview" in entry, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailmap aliases and repeated names count once, and commits outside the window do not count", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const root = repository([
    {
      path: ".mailmap",
      date: daysBefore(200),
      text: "Canonical Name <canonical@example.com> Old Name <old@example.com>\n",
    },
    // Outside the 30-day window, so not a reviewer even though the name differs.
    { path: "guide/keys.md", date: daysBefore(100), author: "Grace Hopper", email: "grace@example.com" },
    // Inside the window, and mapped to the same identity as the commit below.
    { path: "guide/keys.md", date: daysBefore(20), author: "Old Name", email: "old@example.com" },
    { path: "guide/keys.md", date: daysBefore(5), author: "Canonical Name", email: "canonical@example.com" },
    // A second email with the same name is still one reviewer.
    { path: "guide/keys.md", date: daysBefore(2), author: "Canonical Name", email: "another@example.com" },
  ]);

  try {
    const model = site([page("/guide/keys/", "guide/keys.md")], {
      "review-policy": { windowDays: 30, minReviewers: 2 },
    });
    const entry = pagesOf(await reportOf(model, { root, asOf: AS_OF }))["/guide/keys/"]!;

    assert.equal(entry.state, "insufficient");
    assert.deepEqual(entry.reviewers, ["Canonical Name"]);
    assert.deepEqual(
      (entry.commits as Array<{ date: string }>).map((commit) => commit.date),
      [daysBefore(2), daysBefore(5), daysBefore(20)],
    );
    assert.deepEqual(entry.lastReview, { date: daysBefore(2), author: "Canonical Name" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one bounded git log per repository covers every page, and no-as-of reads no git", { skip: process.platform === "win32" ? "a POSIX shell is required" : false }, async () => {
  const root = repository([
    { path: "a.md", date: daysBefore(10), author: "Ada Lovelace" },
    { path: "b.md", date: daysBefore(9), author: "Grace Hopper" },
  ]);
  const bin = mkdtempSync(join(tmpdir(), "review-coverage-bin-"));
  const log = join(bin, "calls.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const originalPath = process.env.PATH;
  try {
    writeFileSync(
      join(bin, "git"),
      ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, `exec '${realGit}' "$@"`, ""].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const model = site([page("/a/", "a.md"), page("/b/", "b.md")], {
      "review-policy": { windowDays: 30, minReviewers: 1 },
    });
    const file = await reportOf(model, { root, asOf: AS_OF });
    assert.equal(pagesOf(file)["/a/"]!.state, "satisfied");

    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const logs = calls.filter((call) => call.startsWith("log "));
    assert.equal(logs.length, 1, calls.join("\n"));
    assert.match(logs[0]!, /--relative/);
    assert.match(logs[0]!, /--since-as-filter=/);

    // A missing as-of cannot measure a window, so it must not read history at all.
    writeFileSync(log, "");
    const noAsOf = await reportOf(model, { root });
    assert.equal(pagesOf(noAsOf)["/a/"]!.state, "no-as-of");
    assert.equal(readFileSync(log, "utf8").trim(), "");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("invalid policy findings are in the report and reported as warnings", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const root = repository([{ path: "guide/one.md", date: daysBefore(5), author: "Ada Lovelace" }]);
  const warnings: Diagnostic[] = [];
  try {
    const model = site([page("/guide/one/", "guide/one.md")], {
      "review-policy": {
        windowDays: 30,
        rules: [
          { path: "../escape", windowDays: 7, minReviewers: 2 },
          { path: "guide/one.md", minReviewers: 2 },
        ],
      },
    });
    const file = await reportOf(model, { root, asOf: AS_OF, report: (diagnostic) => warnings.push(diagnostic) });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.id, "review-policy.invalid-rule");
    assert.equal(warnings[0]!.severity, "warning");

    const body = bodyOf(file);
    assert.equal((body.diagnostics as unknown[]).length, 1);
    assert.equal((body.diagnostics as Array<{ rule: number }>)[0]!.rule, 1);
    assert.deepEqual(pagesOf(file)["/guide/one/"]!.policy, {
      windowDays: 30,
      minReviewers: 2,
      path: "guide/one.md",
    });
    assert.equal(pagesOf(file)["/guide/one/"]!.state, "insufficient");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report is deterministic: sorted pages, fixed key order, and one trailing LF", { skip: hasGit() ? false : "git is not installed" }, async () => {
  const root = repository([
    { path: "a.md", date: daysBefore(10), author: "Ada Lovelace" },
    { path: "b.md", date: daysBefore(10), author: "Ada Lovelace" },
  ]);
  try {
    const model = site([page("/b/", "b.md"), page("/a/", "a.md")], {
      "review-policy": { windowDays: 30, minReviewers: 1 },
    });
    const first = await reportOf(model, { root, asOf: AS_OF });
    const second = await reportOf(model, { root, asOf: AS_OF });
    assert.equal(first.contents, second.contents, "two runs write the same bytes");

    const text = String(first.contents);
    assert.ok(
      text.startsWith(
        '{\n  "version": 1,\n  "asOf": "2026-11-11T00:00:00.000Z",\n  "policy": {\n    "default": {\n      "windowDays": 30,\n      "minReviewers": 1\n    },\n    "rules": []\n  },\n  "diagnostics": [],\n  "pages": {\n',
      ),
      "the header comes first, in a fixed key order",
    );
    assert.ok(text.indexOf('"/a/"') < text.indexOf('"/b/"'), "pages are sorted by URL");
    const entries = text.slice(text.indexOf('"pages": {'));
    assert.ok(
      entries.indexOf('"key"') < entries.indexOf('"url"') &&
        entries.indexOf('"url"') < entries.indexOf('"source"') &&
        entries.indexOf('"source"') < entries.indexOf('"policy"') &&
        entries.indexOf('"policy"') < entries.indexOf('"state"') &&
        entries.indexOf('"state"') < entries.indexOf('"lastReview"') &&
        entries.indexOf('"lastReview"') < entries.indexOf('"reviewers"') &&
        entries.indexOf('"reviewers"') < entries.indexOf('"commits"'),
      "each entry keeps its key order",
    );
    assert.ok(text.endsWith("}\n"), "one trailing LF");
    assert.equal(validate(bodyOf(first)), true, JSON.stringify(validate.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the schema rejects an unknown state, missing evidence, and an unknown diagnostic", async () => {
  const body = bodyOf(await reportOf(site([page("/a/", "a.md")])));
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...body, version: 2 }), false);
  assert.equal(validate({ ...body, asOf: "yesterday" }), false);

  const pages = body.pages as Record<string, Record<string, unknown>>;
  assert.equal(validate({ ...body, pages: { "/a/": { ...pages["/a/"], state: "passed" } } }), false);
  assert.equal(validate({ ...body, pages: { "/a/": { ...pages["/a/"], reviewers: undefined } } }), false);
  assert.equal(validate({ ...body, diagnostics: [{ code: "made.up", message: "no" }] }), false);
});

test("review-coverage is on by default and disabling it leaves trust.json bytes unchanged", async () => {
  // The same title on both roots: a site's default title is its folder name, which would change the HTML.
  const onRoot = tree({ "mizzen.yml": "title: Example\n", "a.md": "---\ntitle: A\n---\n# A\n" });
  const offRoot = tree({
    "mizzen.yml": "title: Example\noutputs:\n  review-coverage: false\n",
    "a.md": "---\ntitle: A\n---\n# A\n",
  });
  const on = outFolder();
  const off = outFolder();
  const previousRoot = process.env.MIZZEN_SITE_ROOT;
  const previousEpoch = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.MIZZEN_SITE_ROOT = onRoot;
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    const built = await build({ root: onRoot, out: on.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.ok(built.files.includes("review-coverage.json"), "the output is on by default");
    const coverage = JSON.parse(readFileSync(join(on.out, "review-coverage.json"), "utf8")) as {
      asOf: string;
      pages: Record<string, { state: string }>;
    };
    assert.equal(coverage.asOf, "2026-01-01T00:00:00.000Z");
    assert.equal(coverage.pages["/a/"]!.state, "unavailable", "a plain folder cannot answer the review window");

    process.env.MIZZEN_SITE_ROOT = offRoot;
    const switched = await build({ root: offRoot, out: off.out, themeRoot: THEME, defaultLayout: "doc" });
    assert.equal(switched.files.includes("review-coverage.json"), false, "the switched-off output writes nothing");
    assert.ok(switched.files.includes("trust.json"));
    assert.equal(
      readFileSync(join(off.out, "trust.json"), "utf8"),
      readFileSync(join(on.out, "trust.json"), "utf8"),
      "the new output does not change trust.json",
    );
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
