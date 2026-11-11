import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { compareClaims, comparePages, driftContentOf } from "../src/drift/compare.ts";
import { codeRefsOf } from "../src/drift/code-refs.ts";

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "drift-compare-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A Markdown page whose body starts at `line` in its source file. */
function page(file: string, markdown: string, line = 1): Page {
  return {
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { file, line, column: 1, endLine: line, endColumn: 1 },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The diagnostics of one page against one root. */
async function compare(root: string, pages: readonly Page[], tolerance?: number): Promise<Diagnostic[]> {
  return compareClaims(pages, tolerance === undefined ? { root } : { root, tolerance });
}

/** A TypeScript file with `buildDocs` on line 2 and `loadConfig` on line 6. */
function source(): string {
  return [
    "// helpers", // 1
    "export function buildDocs() {", // 2
    "  return 1;", // 3
    "}", // 4
    "", // 5
    "export function loadConfig() {", // 6
    "  return 2;", // 7
    "}", // 8
  ].join("\n");
}

test("a citation on a declaration is clean, with or without a claimed symbol", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const pages = [
      page("plain.md", "See src/build.ts:2 for the entry point."),
      page("claim.md", "Call `buildDocs()` at src/build.ts:2."),
      page("range.md", "The pair lives at src/build.ts:4-7."),
      page("command.md", "Run `node` before reading src/build.ts:2."),
      page("elsewhere.md", "Use `parseConfig()` above.\n\nSee src/build.ts:2."),
    ];
    assert.deepEqual(await compare(root, pages), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing file is reported at the reference's own span", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const body = "The old guide points at src/gone.ts:3.";
    const [ref] = await codeRefsOf(page("guide/setup.md", body));
    const diagnostics = await compare(root, [page("guide/setup.md", body)]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.missing-file");
    assert.deepEqual(diagnostics[0]!.pos, ref!.pos);
    assert.match(diagnostics[0]!.message, /src\/gone\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claimed symbol the file no longer exports is missing", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const body = "Run `parseConfig()` at src/build.ts:2.";
    const [ref] = await codeRefsOf(page("setup.md", body));
    const diagnostics = await compare(root, [page("setup.md", body)]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.missing-symbol");
    assert.deepEqual(diagnostics[0]!.pos, ref!.pos);
    assert.match(diagnostics[0]!.message, /does not export "parseConfig"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claimed symbol within the tolerance is clean, and outside it is moved", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const within = page("within.md", "See `loadConfig()` at src/build.ts:11.");
    const outside = page("outside.md", "See `loadConfig()` at src/build.ts:12.");
    assert.deepEqual(await compare(root, [within]), []);

    const diagnostics = await compare(root, [outside]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.moved-symbol");
    assert.match(diagnostics[0]!.message, /declares "loadConfig" at line 6/);
    assert.match(diagnostics[0]!.help ?? "", /line 6/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tolerance option moves the boundary", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const pageBody = page("build.md", "See `loadConfig()` at src/build.ts:9.");
    assert.deepEqual(await compare(root, [pageBody], 3), []);
    const diagnostics = await compare(root, [pageBody], 2);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.moved-symbol");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with no claimed symbol, a distant declaration is a moved symbol and names its line", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const diagnostics = await compare(root, [page("build.md", "See src/build.ts:20.")]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.moved-symbol");
    assert.match(diagnostics[0]!.message, /nearest is "loadConfig" at line 6/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a TypeScript file that exports nothing is missing its symbol", async () => {
  const root = site();
  try {
    write(root, "src/empty.ts", "const local = 1;\n");
    const diagnostics = await compare(root, [page("build.md", "See src/empty.ts:1.")]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.missing-symbol");
    assert.match(diagnostics[0]!.message, /exports no symbols/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-TypeScript file is checked for existence and line range only", async () => {
  const root = site();
  try {
    write(root, "docs/notes.md", "# Notes\n\nA line.\n");
    assert.deepEqual(await compare(root, [page("guide.md", "See docs/notes.md:3.")]), []);

    const diagnostics = await compare(root, [page("guide.md", "See docs/notes.md:4.")]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.line-out-of-range");
    assert.match(diagnostics[0]!.message, /has 3 lines/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Persian and multiline pages keep the reference's exact source span", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const markdown = ["مقدمه", "", "برای ساخت، `buildDocs()` را", "در ../src/build.ts:40 ببینید."].join("\n");
    const file = "guide/setup.md";
    const pages = [page(file, markdown, 4)];
    const [ref] = await codeRefsOf(page(file, markdown, 4));
    // The reference sits in a paragraph that starts on the claim's line; N07 spans the whole run.
    assert.equal(ref?.pos.line, 6);
    assert.equal(ref?.pos.endLine, 7);

    const diagnostics = await compare(root, pages);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.moved-symbol");
    assert.deepEqual(diagnostics[0]!.pos, ref!.pos);
    assert.match(diagnostics[0]!.message, /declares "buildDocs" at line 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target outside the root is refused, even through a symbolic link", async () => {
  const root = site();
  const outside = mkdtempSync(join(tmpdir(), "drift-outside-"));
  try {
    writeFileSync(join(outside, "secret.ts"), "export function secret() {}\n");
    mkdirSync(join(root, "guide", "src"), { recursive: true });
    symlinkSync(join(outside, "secret.ts"), join(root, "guide", "src", "secret.ts"));

    const diagnostics = await compare(root, [page("guide/setup.md", "See src/secret.ts:1.")]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.id, "drift.outside-root");
    assert.match(diagnostics[0]!.message, /outside the site root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("diagnostics are deterministic: page order, then line and message", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const pages = [
      page("a.md", "See src/zzz.ts:1.\n\nSee `parseConfig()` at src/build.ts:2."),
      page("b.md", "`src/zzz.ts:1 src/aaa.ts:1`"),
    ];
    const first = await compare(root, pages);
    const second = await compare(root, pages);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((diagnostic) => [diagnostic.pos?.line, diagnostic.id]),
      [
        [1, "drift.missing-file"],
        [3, "drift.missing-symbol"],
        [1, "drift.missing-file"],
        [1, "drift.missing-file"],
      ],
    );
    // Two misses at the same span keep code-point order by message.
    assert.ok(first[2]!.message.includes("src/aaa.ts"));
    assert.ok(first[3]!.message.includes("src/zzz.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a comparison carries an identity of the page content and every cited source", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const model = page("setup.md", "See `buildDocs()` at src/build.ts:2 and src/notes.txt:1.");
    const [comparison] = await comparePages([model], { root });
    assert.equal(comparison?.file, "setup.md");
    assert.equal(comparison?.references.length, 2);
    assert.equal(comparison?.identity.content, driftContentOf(model));
    assert.match(comparison?.identity.content ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(comparison?.identity.sources ?? {}), ["src/build.ts", "src/notes.txt"]);
    assert.match(comparison?.identity.sources["src/build.ts"] ?? "", /^[0-9a-f]{64}$/);
    assert.equal(comparison?.identity.sources["src/notes.txt"], "missing");
    assert.deepEqual(comparison?.diagnostics.map((diagnostic) => diagnostic.id), ["drift.missing-file"]);

    const [again] = await comparePages([model], { root });
    assert.deepEqual(again?.identity, comparison?.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the identity changes with the page content, the tolerance, or a source's bytes", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const model = page("setup.md", "See src/build.ts:2.");
    const before = (await comparePages([model], { root }))[0]!.identity;

    const moved = (await comparePages([page("setup.md", "An intro line.\n\nSee src/build.ts:2.")], { root }))[0]!.identity;
    assert.notEqual(moved.content, before.content);
    assert.deepEqual(moved.sources, before.sources);

    const wide = (await comparePages([model], { root, tolerance: 2 }))[0]!.identity;
    assert.notEqual(wide.content, before.content);

    write(root, "src/build.ts", `${source()}\n// changed\n`);
    const changed = (await comparePages([model], { root }))[0]!.identity;
    assert.equal(changed.content, before.content);
    assert.notEqual(changed.sources["src/build.ts"], before.sources["src/build.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finding keeps the reference's moved line and names the declaration's current line", async () => {
  const root = site();
  try {
    write(root, "src/build.ts", source());
    const before = page("setup.md", "See `loadConfig()` at src/build.ts:12.");
    const [firstReference] = await codeRefsOf(before);
    const after = page("setup.md", "# Guide\n\nIntro.\n\nSee `loadConfig()` at src/build.ts:12.");
    const [movedReference] = await codeRefsOf(after);
    assert.equal(movedReference?.pos.line, (firstReference?.pos.line ?? 0) + 4);
    assert.equal(movedReference?.line, firstReference?.line);

    const diagnostics = await compare(root, [after]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.id, "drift.moved-symbol");
    assert.deepEqual(diagnostics[0]?.pos, movedReference?.pos);
    assert.match(diagnostics[0]?.message ?? "", /declares "loadConfig" at line 6/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a renamed or deleted target is reported at the path the page still cites", async () => {
  const root = site();
  try {
    write(root, "src/new.ts", source());
    const model = page("guide/setup.md", "See `buildDocs()` at src/old.ts:2.");
    const [comparison] = await comparePages([model], { root });

    assert.equal(comparison?.identity.sources["guide/src/old.ts"], "missing");
    assert.equal(comparison?.diagnostics.length, 1);
    assert.equal(comparison?.diagnostics[0]?.id, "drift.missing-file");
    assert.match(comparison?.diagnostics[0]?.message ?? "", /guide\/src\/old\.ts/);
    assert.deepEqual(comparison?.diagnostics[0]?.pos, comparison?.references[0]?.pos);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unresolvable reference is marked outside and contributes no source bytes", async () => {
  const root = site();
  const outside = mkdtempSync(join(tmpdir(), "drift-outside-"));
  try {
    writeFileSync(join(outside, "secret.ts"), "export function secret() {}\n");
    mkdirSync(join(root, "guide", "src"), { recursive: true });
    symlinkSync(join(outside, "secret.ts"), join(root, "guide", "src", "secret.ts"));

    const model = page("guide/setup.md", "See src/secret.ts:1.");
    const [comparison] = await comparePages([model], { root });
    assert.equal(comparison?.identity.sources["guide/src/secret.ts"], "outside");
    assert.equal(comparison?.diagnostics.length, 1);
    assert.equal(comparison?.diagnostics[0]?.id, "drift.outside-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
