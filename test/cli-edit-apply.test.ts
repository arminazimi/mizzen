import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, parseArgs } from "../src/cli/index.ts";
import { unifiedDiff } from "../src/cli/edit-apply.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cli-edit-apply-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes `patch` as JSON beside `root` and returns its path. */
function patchAt(root: string, patch: Patch, name = "patch.json"): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(patch, null, 2)}\n`);
  return path;
}

/** A patch that replaces `# Old` with `# New` on line 1 of `docs/a.md`. */
function headingPatch(source: string, overrides: Partial<Patch> = {}): Patch {
  return {
    span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    expected: "# Old",
    replacement: "# New",
    beforeHash: hashSource(source),
    ...overrides,
  };
}

/** SHA-256, as the proof record writes it. */
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (message: string) => {
        logs.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

test("parseArgs: edit apply takes a patch, an optional site root, and its flags", () => {
  assert.deepEqual(parseArgs(["edit", "apply", "patch.json"]), {
    options: { command: "edit-apply", root: ".", patch: "patch.json", dryRun: false },
  });
  assert.deepEqual(parseArgs(["edit", "apply", "patch.json", "site", "--dry-run", "--proof", "p.json"]), {
    options: { command: "edit-apply", root: "site", patch: "patch.json", dryRun: true, proof: "p.json" },
  });
  assert.deepEqual(parseArgs(["edit", "--help"]), { help: true });
  assert.deepEqual(parseArgs(["edit", "apply", "--help"]), { help: true });
  assert.equal("error" in parseArgs(["edit"]), true);
  assert.equal("error" in parseArgs(["edit", "nope"]), true);
  assert.equal("error" in parseArgs(["edit", "apply"]), true);
  assert.equal("error" in parseArgs(["edit", "apply", "p.json", "site", "extra"]), true);
  assert.equal("error" in parseArgs(["edit", "apply", "p.json", "--out", "dist"]), true);
  assert.equal("error" in parseArgs(["edit", "apply", "p.json", "--proof"]), true);
});

test("edit apply writes the file and its proof, and prints the proof path", async () => {
  const source = "# Old\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  const { logs, errors, io } = capture();
  try {
    const code = await main(["edit", "apply", patch, root], io);
    assert.equal(code, 0, errors.join("\n"));
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "# New\n\nBody\n");

    const proof = `${patch}.proof.json`;
    assert.ok(existsSync(proof));
    assert.ok(logs.includes(`mizzen edit apply: proof ${proof}`));
    const record = JSON.parse(readFileSync(proof, "utf8")) as {
      version: number;
      files: { path: string; before: string; after: string }[];
      date?: string;
    };
    assert.equal(record.version, 1);
    assert.deepEqual(record.files, [
      { path: "docs/a.md", before: hash(source), after: hash("# New\n\nBody\n") },
    ]);
    assert.equal("date" in record, false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("edit apply writes the proof to --proof when given", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  const proof = join(root, "records", "edit.json");
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root, "--proof", proof], io), 0, errors.join("\n"));
    assert.ok(existsSync(proof));
    assert.equal(existsSync(`${patch}.proof.json`), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a failed expected text leaves the file byte-identical, writes no proof, and exits 1", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source, { expected: "# Nope" }));
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.proof.json`), false);
    assert.equal(logs.length, 0);
    assert.ok(errors[0]?.includes("refused"));
    assert.ok(errors[0]?.includes("unchanged"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a stale beforeHash is refused and leaves the file unchanged", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source, { beforeHash: "0".repeat(64) }));
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.proof.json`), false);
    assert.ok(errors[0]?.includes("hash-mismatch") || errors[0]?.includes("hashes to"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a patch with no expected text or hash is applied, since both are optional", async () => {
  const root = tree({ "docs/a.md": "# Old\n" });
  const patch = patchAt(root, {
    span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    replacement: "# New",
  });
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 0, errors.join("\n"));
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "# New\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("--dry-run prints a diff and writes neither the source nor the proof", async () => {
  const source = "# Old\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root, "--dry-run"], io), 0, errors.join("\n"));
    const output = logs.join("\n");
    assert.match(output, /^--- a\/docs\/a\.md$/m);
    assert.match(output, /^\+\+\+ b\/docs\/a\.md$/m);
    assert.match(output, /^-# Old$/m);
    assert.match(output, /^\+# New$/m);
    assert.ok(logs.some((line) => line.includes("would change")));
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.proof.json`), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a missing patch is a usage error: exit 2", async () => {
  const root = tree();
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", join(root, "nope.json"), root], io), 2);
    assert.ok(errors[0]?.includes("cannot read the patch"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a patch that is not a patch, or not JSON, is a usage error: exit 2", async () => {
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    const notJson = join(root, "bad.json");
    writeFileSync(notJson, "nope");
    const first = capture();
    assert.equal(await main(["edit", "apply", notJson, root], first.io), 2);
    assert.ok(first.errors[0]?.includes("not JSON"));

    const noFile = patchAt(root, {
      span: { line: 1, column: 1, endLine: 1, endColumn: 5 },
      replacement: "# New",
    } as Patch);
    const second = capture();
    assert.equal(await main(["edit", "apply", noFile, root], second.io), 2);
    assert.ok(second.errors[0]?.includes("span.file"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("edit with an unknown subcommand is a usage error: exit 2", async () => {
  const { errors, io } = capture();
  assert.equal(await main(["edit", "rewrite"], io), 2);
  assert.ok(errors[0]?.includes("unknown edit subcommand"));
});

test("a patch whose span.file leaves the site root is refused and touches nothing", async () => {
  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n" });
  const site = join(parent, "site");
  const patch = patchAt(parent, {
    span: { file: "../outside.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    expected: "# Old",
    replacement: "# New",
  });
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, site], io), 1);
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(readFileSync(join(site, "docs", "a.md"), "utf8"), "# Old\n");
    assert.equal(existsSync(`${patch}.proof.json`), false);
    assert.ok(errors[0]?.includes("outside the site root"));
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("a span outside the source is refused and leaves the file unchanged", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source, { span: { file: "docs/a.md", line: 9, column: 1, endLine: 9, endColumn: 5 } }));
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.ok(errors[0]?.includes("outside the source"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("unifiedDiff keeps three lines of context around one changed line", () => {
  const before = `# Title\n\none\ntwo\n# Old\nfour\nfive\nsix\n`;
  const after = `# Title\n\none\ntwo\n# New\nfour\nfive\nsix\n`;
  const diff = unifiedDiff(before, after, "docs/a.md");
  assert.equal(
    diff,
    [
      "--- a/docs/a.md",
      "+++ b/docs/a.md",
      "@@ -2,7 +2,7 @@",
      " ",
      " one",
      " two",
      "-# Old",
      "+# New",
      " four",
      " five",
      " six",
      "",
    ].join("\n"),
  );
  assert.equal(unifiedDiff(before, before, "docs/a.md"), "");
});
