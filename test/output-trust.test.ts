import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** The report's page entries, keyed by URL. */
function pagesOf(file: OutputFile): Record<string, Record<string, unknown>> {
  return bodyOf(file).pages as Record<string, Record<string, unknown>>;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The page key the report is expected to write for a URL and source file. */
function pageKey(url: string, source = POS.file): string {
  return hash(`${url}\0${source}`);
}

/** The build identifier the report is expected to write for these pages. */
function buildId(ordered: readonly Page[]): string {
  return hash(
    ordered
      .map((entry) => `${pageKey(entry.url, entry.source.file)}\0${hash(entry.markdown)}\0${hash(entry.html)}\n`)
      .join(""),
  );
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
  assert.deepEqual(pagesOf(file), {
    "/guide/install/": {
      key: pageKey("/guide/install/"),
      url: "/guide/install/",
      source: POS.file,
      evidence: { examples: "measured", drift: "measured", review: "measured" },
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

  const entry = pagesOf(await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" }))["/guide/install/"]!;
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

  const entry = pagesOf(await reportOf(model, { asOf: "2026-10-02T00:00:00.000Z" }))["/guide/install/"]!;
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

  const entry = pagesOf(await reportOf(model, { asOf: "2026-07-01T00:00:00.000Z" }))["/guide/install/"]!;
  assert.equal(entry.level, "review-due");
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[2], {
    code: "review.overdue",
    message: "Last reviewed 181 days ago, past the 180-day limit.",
  });
});

test("unknown inputs write unknown reasons and never claim verified", async () => {
  const markdown = ["```ts test", 'console.log("hi");', "```", ""].join("\n");
  const file = await reportOf(site([page("/guide/run/", markdown)]));

  assert.deepEqual(pagesOf(file), {
    "/guide/run/": {
      key: pageKey("/guide/run/"),
      url: "/guide/run/",
      source: POS.file,
      evidence: { examples: "unknown", drift: "missing", review: "missing" },
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
  const entry = pagesOf(file)["/guide/plain/"]!;
  assert.deepEqual((entry.evidence as Record<string, unknown>).examples, "none");
  assert.deepEqual((entry.reasons as Array<Record<string, unknown>>)[0], {
    code: "examples.none",
    message: "The page declares no runnable examples.",
  });
});

test("every doc page is present, with a stable key, url, and source; app pages are left out", async () => {
  const app: Page = { ...page("/dashboard/", "", "dashboard/index.html"), kind: "app" };
  const file = await reportOf(site([page("/b/"), app, page("/a/", "# A\n", "a.md")]));
  const pages = pagesOf(file);

  assert.deepEqual(Object.keys(pages), ["/a/", "/b/"]);
  assert.equal(pages["/a/"]!.key, pageKey("/a/", "a.md"));
  assert.equal(pages["/a/"]!.url, "/a/");
  assert.equal(pages["/a/"]!.source, "a.md");
  assert.equal(pages["/b/"]!.key, pageKey("/b/"));
  assert.notEqual(pages["/a/"]!.key, pages["/b/"]!.key);
  assert.equal((bodyOf(file).build as Record<string, unknown>).pages, 2);
});

test("a page key is stable when only the evidence changes", async () => {
  const model = site([page("/guide/install/")], { drift: { "/guide/install/": 0 } });
  const first = pagesOf(await reportOf(model));
  const second = pagesOf(
    await reportOf(
      site([page("/guide/install/")], {
        examples: { "/guide/install/": { passed: 2, failed: 0 } },
        reviewers: { "/guide/install/": { date: "2026-10-01T00:00:00.000Z", author: "Ada" } },
      }),
      { asOf: "2026-10-02T00:00:00.000Z" },
    ),
  );

  assert.equal(first["/guide/install/"]!.key, second["/guide/install/"]!.key);
});

test("the build identifier is identical for equivalent builds and changes with page content", async () => {
  const first = bodyOf(await reportOf(site([page("/b/"), page("/a/")])));
  const reordered = bodyOf(await reportOf(site([page("/a/"), page("/b/")])));
  const changed = bodyOf(await reportOf(site([page("/b/"), page("/a/", "# Different\n")])));

  assert.equal((first.build as Record<string, unknown>).algorithm, "sha256");
  assert.equal((first.build as Record<string, unknown>).id, buildId([page("/a/"), page("/b/")]));
  assert.equal((first.build as Record<string, unknown>).id, (reordered.build as Record<string, unknown>).id);
  assert.notEqual((first.build as Record<string, unknown>).id, (changed.build as Record<string, unknown>).id);
});

test("invalid drift and reviewer data are unknown, not missing, even without a root", async () => {
  const model = site([page("/guide/install/")], {
    drift: { "/guide/install/": "many" },
    reviewers: { "/guide/install/": { date: "not-a-date", author: "Ada" } },
  });

  const entry = pagesOf(await reportOf(model))["/guide/install/"]!;
  assert.deepEqual(entry.evidence, { examples: "none", drift: "unknown", review: "unknown" });
  assert.deepEqual(
    (entry.reasons as Array<Record<string, unknown>>).map((reason) => reason.code),
    ["examples.none", "drift.unknown", "review.unknown"],
  );
  assert.equal(entry.level, "at-risk");
});

test("invalid data still falls back to a healthy git answer when a root is available", { skip: !hasGit() }, async () => {
  const root = repository([
    { path: "guide/install.md", date: "2026-10-01T00:00:00Z", author: "Ada Lovelace", text: "# Install\n" },
  ]);
  try {
    const model = site([page("/guide/install/")], {
      examples: { "/guide/install/": { passed: 2, failed: 0 } },
      drift: { "/guide/install/": "many" },
      reviewers: { "/guide/install/": { date: "not-a-date", author: "Ada" } },
    });
    const entry = pagesOf(await reportOf(model, { root, asOf: "2026-10-10T00:00:00.000Z" }))[
      "/guide/install/"
    ]!;

    assert.deepEqual(entry.evidence, { examples: "measured", drift: "measured", review: "measured" });
    assert.equal(entry.lastReviewer, "Ada Lovelace");
    assert.equal(entry.level, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence distinguishes a missing source from an unknown answer", async () => {
  const unknown = trustEntryOf({
    driftState: "unknown",
    review: "unknown",
    reviewState: "unknown",
  });
  assert.deepEqual(unknown.evidence, { examples: "none", drift: "unknown", review: "unknown" });

  // Without a root neither signal has a source; with one, git is asked but a plain folder has no answer.
  const noRoot = pagesOf(await reportOf(site([page("/guide/install/")])))["/guide/install/"]!;
  assert.deepEqual(noRoot.evidence, { examples: "none", drift: "missing", review: "missing" });

  const root = mkdtempSync(join(tmpdir(), "trust-root-"));
  try {
    const withRoot = pagesOf(await reportOf(site([page("/guide/install/")]), { root }))["/guide/install/"]!;
    assert.deepEqual(withRoot.evidence, { examples: "none", drift: "measured", review: "unknown" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("URLs are sorted and the bytes are fixed: header, key order, two spaces, LF", async () => {
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

  const text = String(first.contents);
  const id = buildId([page("/a/"), page("/b/")]);
  assert.ok(
    text.startsWith(
      `{\n  "version": 1,\n  "build": {\n    "algorithm": "sha256",\n    "id": ${JSON.stringify(id)},\n    "pages": 2\n  },\n  "pages": {\n`,
    ),
    "the header comes first, in a fixed key order",
  );
  assert.ok(text.indexOf('"/a/"') < text.indexOf('"/b/"'), "pages are sorted by URL");
  assert.ok(
    text.indexOf('"key"') <
      text.indexOf('"url"') &&
      text.indexOf('"url"') < text.indexOf('"source"') &&
      text.indexOf('"source"') < text.indexOf('"evidence"') &&
      text.indexOf('"evidence"') < text.indexOf('"level"') &&
      text.indexOf('"level"') < text.indexOf('"reasons"') &&
      text.indexOf('"reasons"') < text.indexOf('"lastReviewer"'),
    "each entry keeps its key order",
  );
  assert.ok(text.endsWith("}\n"), "one trailing LF");
  assert.equal(validate(bodyOf(first)), true, JSON.stringify(validate.errors));
});

test("the schema requires the build identity and rejects an entry with no reasons or an unknown code", () => {
  const base = {
    version: 1,
    build: { algorithm: "sha256", id: "a".repeat(64), pages: 1 },
    pages: {
      "/a/": {
        key: "a".repeat(64),
        url: "/a/",
        source: "a.md",
        evidence: { examples: "none", drift: "measured", review: "measured" },
        level: "verified",
        reasons: [
          { code: "examples.none", message: "none" },
          { code: "drift.clean", message: "clean" },
          { code: "review.recent", message: "recent" },
        ],
      },
    },
  };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, version: 2 }), false);
  assert.equal(validate({ ...base, build: { algorithm: "sha256", pages: 1 } }), false);
  assert.equal(validate({ ...base, pages: { "/a/": { ...base.pages["/a/"], reasons: [] } } }), false);
  assert.equal(
    validate({
      ...base,
      pages: { "/a/": { ...base.pages["/a/"], reasons: [{ code: "made.up", message: "no" }] } },
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
    const entry = pagesOf(file)["/guide/install/"]!;
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
    const entry = pagesOf(file)["/guide/setup/"]!;
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
  assert.deepEqual(entry.evidence, { examples: "unknown", drift: "measured", review: "measured" });
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
    const body = JSON.parse(readFileSync(join(on.out, "trust.json"), "utf8")) as {
      build: Record<string, unknown>;
      pages: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(body.pages), ["/a/"]);
    assert.equal(body.pages["/a/"]?.level, "review-due");
    assert.equal(typeof body.build.id, "string");
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

test("build.id follows the final layout HTML and stays stable for equivalent builds", async () => {
  const root = tree({ "a.md": "---\ntitle: A\n---\n# A\n" });
  const first = outFolder();
  const second = outFolder();
  const otherLayout = outFolder();
  const previousRoot = process.env.MIZZEN_SITE_ROOT;
  try {
    process.env.MIZZEN_SITE_ROOT = root;
    const doc = await build({ root, out: first.out, themeRoot: THEME, defaultLayout: "doc" });
    await build({ root, out: second.out, themeRoot: THEME, defaultLayout: "doc" });
    const home = await build({ root, out: otherLayout.out, themeRoot: THEME, defaultLayout: "home" });

    assert.ok(doc.files.includes("trust.json"));
    assert.ok(home.files.includes("trust.json"));
    const docHtml = readFileSync(join(first.out, "a", "index.html"), "utf8");
    const homeHtml = readFileSync(join(otherLayout.out, "a", "index.html"), "utf8");
    assert.notEqual(docHtml, homeHtml, "the layouts write different documents");

    const idOf = (dir: string) =>
      (JSON.parse(readFileSync(join(dir, "trust.json"), "utf8")) as { build: { id: string } }).build.id;
    assert.equal(idOf(first.out), idOf(second.out), "equivalent builds share one id");
    assert.notEqual(idOf(first.out), idOf(otherLayout.out), "a different layout changes the id");
  } finally {
    if (previousRoot === undefined) delete process.env.MIZZEN_SITE_ROOT;
    else process.env.MIZZEN_SITE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
    for (const folder of [first, second, otherLayout]) rmSync(folder.parent, { recursive: true, force: true });
  }
});
