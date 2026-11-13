import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "../src/contracts/content.ts";
import { compareClaims, comparePages } from "../src/drift/compare.ts";

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "drift-compare-bytes-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, bytes: string | Uint8Array): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
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

/** The SHA-256 of the bytes, as the comparison must report it. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Text and one invalid byte that survives decoding as U+FFFD nonetheless. */
function withInvalidByte(text: string, byte: number): Buffer {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([byte])]);
}

test("a source identity is the SHA-256 of the file's exact bytes", async () => {
  const root = site();
  try {
    const text = "export function buildDocs() {\n  return 1;\n}\n";
    const notes = withInvalidByte("line one\n", 0xff);
    write(root, "src/build.ts", text);
    write(root, "src/notes.txt", notes);

    const [comparison] = await comparePages(
      [page("setup.md", "See `buildDocs()` at src/build.ts:1 and src/notes.txt:1.")],
      { root },
    );

    assert.equal(comparison?.identity.sources["src/build.ts"], sha256(Buffer.from(text, "utf8")));
    assert.equal(comparison?.identity.sources["src/notes.txt"], sha256(notes));
    assert.deepEqual(comparison?.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a byte-only change that decodes to the same text changes the identity", async () => {
  const before = site();
  const after = site();
  try {
    const head = "one line\n";
    const original = withInvalidByte(head, 0xff);
    const changed = withInvalidByte(head, 0xfe);
    write(before, "src/notes.txt", original);
    write(after, "src/notes.txt", changed);

    // The two files are byte-distinct but decode to exactly the same replacement text.
    assert.equal(readFileSync(join(before, "src/notes.txt"), "utf8"), readFileSync(join(after, "src/notes.txt"), "utf8"));
    assert.equal(new TextDecoder().decode(original), new TextDecoder().decode(changed));

    const model = page("setup.md", "See src/notes.txt:1.");
    const [prior] = await comparePages([model], { root: before });
    const [next] = await comparePages([model], { root: after });

    assert.deepEqual(next?.diagnostics, prior?.diagnostics);
    assert.equal(next?.identity.content, prior?.identity.content);
    assert.notEqual(next?.identity.sources["src/notes.txt"], prior?.identity.sources["src/notes.txt"]);
  } finally {
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
});

test("valid UTF-8 sources keep their line checks and signature findings", async () => {
  const root = site();
  try {
    write(root, "src/notes.txt", "café\nübersetzt\n");
    const source = ["// café", "export function größer(limit: number): number {", "  return limit;", "}"].join(
      "\n",
    );
    write(root, "src/build.ts", source);

    const pages = [
      page("inside.md", "See src/notes.txt:2."),
      page("outside.md", "See src/notes.txt:3."),
      page("signature.md", "Call `größer(limit: string): number` at src/build.ts:2."),
    ];
    const diagnostics = await compareClaims(pages, { root });

    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), ["drift.line-out-of-range", "drift.signature-mismatch"]);
    assert.match(diagnostics[0]?.message ?? "", /"src\/notes.txt" has 2 lines, but this reference cites line 3/);
    assert.match(diagnostics[1]?.message ?? "", /"src\/build.ts" declares "größer" as ".*größer\(limit:number\): number"/);

    const [comparison] = await comparePages([pages[2] as Page], { root });
    assert.equal(comparison?.identity.sources["src/build.ts"], sha256(Buffer.from(source, "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated citations of one target keep one identity and one set of findings", async () => {
  const root = site();
  try {
    const notes = withInvalidByte("only line\n", 0xc3);
    write(root, "src/notes.txt", notes);
    const model = page("setup.md", "First src/notes.txt:1.\n\nAgain src/notes.txt:1.");

    const [comparison] = await comparePages([model], { root });
    const [again] = await comparePages([model], { root });

    assert.deepEqual(Object.keys(comparison?.identity.sources ?? {}), ["src/notes.txt"]);
    assert.equal(comparison?.identity.sources["src/notes.txt"], sha256(notes));
    assert.deepEqual(comparison?.diagnostics, []);
    assert.deepEqual(again?.identity, comparison?.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
