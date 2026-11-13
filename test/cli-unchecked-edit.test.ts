import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { EditApplyReport } from "../src/cli/edit-apply.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cli-unchecked-edit-"));
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

/** A patch with neither precondition. */
function uncheckedPatch(): Patch {
  return {
    span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    replacement: "# New",
  };
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

/** The one machine-readable document a `--format json` run printed to stdout. */
function report(logs: readonly string[]): EditApplyReport {
  assert.equal(logs.length, 1, logs.join("\n"));
  return JSON.parse(logs[0]!) as EditApplyReport;
}

/** Asserts the source, its proof, and its audit ledger are exactly as they were. */
function assertUntouched(root: string, patch: string, source: string): void {
  assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
  assert.equal(existsSync(`${patch}.proof.json`), false);
  assert.equal(existsSync(`${patch}.audit.jsonl`), false);
}

test("a patch with neither precondition is refused before anything is written", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, uncheckedPatch());
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 2);
    assert.deepEqual(logs, []);
    assert.match(errors[0] ?? "", /neither "expected" nor "beforeHash"/);
    assert.match(errors[0] ?? "", /--allow-unchecked/);
    assertUntouched(root, patch, source);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the unchecked refusal is machine-readable and names the override", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, uncheckedPatch());
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root, "--format", "json"], io), 2);
    assert.deepEqual(errors, []);
    const out = report(logs);
    assert.equal(out.status, "invalid");
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 2);
    assert.equal(out.applied, false);
    assert.equal(out.diagnostics.length, 1);
    const diagnostic = out.diagnostics[0]!;
    assert.equal(diagnostic.code, "edit.patch-unchecked");
    assert.equal(diagnostic.path, "docs/a.md");
    assert.deepEqual(diagnostic.span, { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 });
    assert.match(diagnostic.message, /--allow-unchecked/);
    assertUntouched(root, patch, source);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("--allow-unchecked applies a precondition-free patch and records proof and audit", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, uncheckedPatch());
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root, "--allow-unchecked"], io), 0, errors.join("\n"));
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "# New\n");
    assert.ok(existsSync(`${patch}.proof.json`));
    const audit = readFileSync(`${patch}.audit.jsonl`, "utf8");
    assert.match(audit, /"outcome":"applied"/);
    assert.ok(logs.includes(`mizzen edit apply: wrote docs/a.md`));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the override cannot apply a patch that carries only one precondition", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const onlyExpected = patchAt(root, { ...uncheckedPatch(), expected: "# Old" }, "expected-only.json");
  const onlyHash = patchAt(root, { ...uncheckedPatch(), beforeHash: hashSource(source) }, "hash-only.json");
  try {
    const expected = capture();
    assert.equal(await main(["edit", "apply", onlyExpected, root, "--allow-unchecked"], expected.io), 1);
    assert.match(expected.errors[0] ?? "", /has no beforeHash/);
    assertUntouched(root, onlyExpected, source);

    const hashed = capture();
    assert.equal(await main(["edit", "apply", onlyHash, root, "--allow-unchecked"], hashed.io), 1);
    assert.match(hashed.errors[0] ?? "", /has no expected text/);
    assertUntouched(root, onlyHash, source);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a dry run of an unchecked patch is refused without the override and writes nothing", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, uncheckedPatch());
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root, "--dry-run"], io), 2);
    assert.deepEqual(logs, []);
    assert.match(errors[0] ?? "", /--allow-unchecked/);
    assertUntouched(root, patch, source);

    const allowed = capture();
    assert.equal(
      await main(["edit", "apply", patch, root, "--dry-run", "--allow-unchecked"], allowed.io),
      0,
      allowed.errors.join("\n"),
    );
    assert.match(allowed.logs.join("\n"), /^\+\# New$/m);
    assert.ok(allowed.logs.some((line) => line.includes("would change")));
    assertUntouched(root, patch, source);
  } finally {
    rmSync(root, { recursive: true });
  }
});
