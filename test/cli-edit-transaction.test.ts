import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import {
  editApply,
  formatEditApplyJson,
  EditApplyError,
  type EditApplyReport,
} from "../src/cli/edit-apply.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";
import { commitArtifacts, TransactionError } from "../src/edits/transaction.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cli-edit-transaction-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes `patch` as JSON beside the tree and returns its path. */
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

/** Every path under `root` with its type and bytes (or link target), for an exact residue check. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const key = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) {
        entries[`${key}/`] = "dir";
        walk(path);
      } else if (entry.isSymbolicLink()) {
        entries[key] = `link:${readlinkSync(path)}`;
      } else {
        entries[key] = `file:${readFileSync(path, "utf8")}`;
      }
    }
  };
  walk(root);
  return entries;
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

test("missing or stale preconditions leave the source, proof, and ledger untouched", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const proof = (name: string): string => join(root, `${name}.proof.json`);
  const ledger = (name: string): string => join(root, `${name}.audit.jsonl`);
  try {
    const cases: readonly [string, Patch][] = [
      // expected without the whole-file hash
      [
        "no-hash",
        {
          span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
          expected: "# Old",
          replacement: "# New",
        },
      ],
      // hash without the exact expected text
      [
        "no-expected",
        {
          span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
          replacement: "# New",
          beforeHash: hashSource(source),
        },
      ],
      // the expected text is not at the span
      ["wrong-expected", headingPatch(source, { expected: "# Nope" })],
      // the source changed since the patch was computed
      ["stale-hash", headingPatch(source, { beforeHash: "0".repeat(64) })],
    ];

    for (const [name, patch] of cases) {
      const path = patchAt(root, patch, `${name}.json`);
      const { errors, io } = capture();
      assert.equal(await main(["edit", "apply", path, root], io), 1, name);
      assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source, `${name} leaves the source`);
      assert.equal(existsSync(proof(name)), false, `${name} writes no proof`);
      assert.equal(existsSync(ledger(name)), false, `${name} writes no ledger`);
      assert.equal(errors.length, 1, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink whose real target leaves the site root is refused before it is read", async () => {
  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n" });
  const site = join(parent, "site");
  symlinkSync(join(parent, "outside.md"), join(site, "docs", "link.md"));
  const patch = patchAt(parent, {
    span: { file: "docs/link.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    expected: "# Old",
    replacement: "# New",
    beforeHash: hashSource("# Old\n"),
  });
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, site], io), 1);
    assert.match(errors[0] ?? "", /outside the site root/);
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(readFileSync(join(site, "docs", "a.md"), "utf8"), "# Old\n");
    assert.equal(existsSync(`${patch}.proof.json`), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a symlink inside the site root is written through and keeps its mode and line endings", async () => {
  const source = "one\r\n# Old\r\nthree\r\n";
  const root = tree({ "shared/real.md": source, "docs/.keep": "" });
  const link = join(root, "docs", "link.md");
  const real = join(root, "shared", "real.md");
  symlinkSync("../shared/real.md", link);
  chmodSync(real, 0o640);
  const patch = patchAt(root, {
    span: { file: "docs/link.md", line: 2, column: 1, endLine: 2, endColumn: 5 },
    expected: "# Old",
    replacement: "# New",
    beforeHash: hashSource(source),
  });
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 0, errors.join("\n"));
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still a link");
    assert.equal(readFileSync(real, "utf8"), "one\r\n# New\r\nthree\r\n");
    assert.equal(statSync(real).mode & 0o777, 0o640, "the source mode is kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid proof or ledger destinations leave every existing byte unchanged", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  try {
    // The proof path is a directory.
    mkdirSync(`${patch}.proof.json`);
    const first = capture();
    assert.equal(await main(["edit", "apply", patch, root, "--format", "json"], first.io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.audit.jsonl`), false);
    const firstReport = report(first.logs);
    assert.equal(firstReport.applied, false);
    assert.equal(firstReport.status, "failed");
    assert.equal(firstReport.diagnostics[0]?.code, "edit.write-failed");
    assert.match(firstReport.diagnostics[0]?.message ?? "", /directory/);
    rmSync(`${patch}.proof.json`, { recursive: true });

    // The ledger path is a directory.
    mkdirSync(`${patch}.audit.jsonl`);
    const second = capture();
    assert.equal(await main(["edit", "apply", patch, root], second.io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.proof.json`), false);
    assert.match(second.errors[0] ?? "", /audit ledger/);
    rmSync(`${patch}.audit.jsonl`, { recursive: true });

    // The proof path collides with the source.
    const third = capture();
    assert.equal(await main(["edit", "apply", patch, root, "--proof", join(root, "docs", "a.md")], third.io), 1);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.audit.jsonl`), false);
    assert.match(third.errors[0] ?? "", /more than once/);

    // A proof parent that is a file cannot become a directory.
    writeFileSync(join(root, "records"), "not a directory\n");
    const fourth = capture();
    assert.equal(
      await main(["edit", "apply", patch, root, "--proof", join(root, "records", "edit.json")], fourth.io),
      1,
    );
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patch}.audit.jsonl`), false);
    assert.match(fourth.errors[0] ?? "", /not a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure before commit restores prior proof and ledger bytes and removes staging", async () => {
  const source = "# Old\n";
  const priorProof = "prior proof bytes\n";
  const priorLedger = `{"prior":true}\n`;
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  writeFileSync(`${patch}.proof.json`, priorProof);
  writeFileSync(`${patch}.audit.jsonl`, priorLedger);
  const before = snapshot(root);
  try {
    await assert.rejects(
      editApply({
        siteRoot: root,
        patch,
        transactionHooks: {
          beforeCommit: () => {
            throw new Error("injected before commit");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditApplyError);
        assert.equal(error.code, "edit.write-failed");
        assert.match(error.message, /nothing was written/);
        return true;
      },
    );
    assert.deepEqual(snapshot(root), before, "no byte and no staging folder changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure during commit restores the source, proof, and ledger", async () => {
  const source = "# Old\n";
  const priorProof = "prior proof bytes\n";
  const priorLedger = `{"prior":true}\n`;

  // The ledger rename fails after the proof was committed.
  const first = tree({ "docs/a.md": source });
  const firstPatch = patchAt(first, headingPatch(source));
  writeFileSync(`${firstPatch}.proof.json`, priorProof);
  writeFileSync(`${firstPatch}.audit.jsonl`, priorLedger);
  const firstBefore = snapshot(first);
  try {
    await assert.rejects(
      editApply({
        siteRoot: first,
        patch: firstPatch,
        transactionHooks: {
          beforeRename: (index) => {
            if (index === 1) throw new Error("injected ledger failure");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditApplyError);
        assert.equal(error.code, "edit.write-failed");
        assert.match(error.message, /restored/);
        return true;
      },
    );
    assert.deepEqual(snapshot(first), firstBefore);
  } finally {
    rmSync(first, { recursive: true, force: true });
  }

  // The source rename fails after the proof and ledger were committed.
  const second = tree({ "docs/a.md": source });
  const secondPatch = patchAt(second, headingPatch(source));
  writeFileSync(`${secondPatch}.proof.json`, priorProof);
  writeFileSync(`${secondPatch}.audit.jsonl`, priorLedger);
  const secondBefore = snapshot(second);
  try {
    await assert.rejects(
      editApply({
        siteRoot: second,
        patch: secondPatch,
        transactionHooks: {
          beforeRename: (index) => {
            if (index === 2) throw new Error("injected source failure");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditApplyError);
        assert.equal(error.code, "edit.write-failed");
        assert.match(error.message, /restored/);
        return true;
      },
    );
    assert.deepEqual(snapshot(second), secondBefore);
  } finally {
    rmSync(second, { recursive: true, force: true });
  }

  // A proof and ledger that did not exist before the failure are removed by the rollback.
  const third = tree({ "docs/a.md": source });
  const thirdPatch = patchAt(third, headingPatch(source));
  const thirdBefore = snapshot(third);
  try {
    await assert.rejects(
      editApply({
        siteRoot: third,
        patch: thirdPatch,
        transactionHooks: {
          beforeRename: (index) => {
            if (index === 2) throw new Error("injected source failure");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditApplyError);
        assert.equal(error.code, "edit.write-failed");
        assert.match(error.message, /restored/);
        return true;
      },
    );
    assert.deepEqual(snapshot(third), thirdBefore, "new artifacts are removed, not left behind");
  } finally {
    rmSync(third, { recursive: true, force: true });
  }
});

test("an incomplete rollback is reported instead of reported as applied", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  try {
    let failure: EditApplyError | undefined;
    await assert.rejects(
      editApply({
        siteRoot: root,
        patch,
        transactionHooks: {
          beforeRename: (index) => {
            if (index === 1) throw new Error("injected ledger failure");
          },
          beforeRestore: () => {
            throw new Error("injected restore failure");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditApplyError);
        failure = error;
        return true;
      },
    );
    assert.ok(failure !== undefined);
    assert.equal(failure.code, "edit.write-failed");
    assert.match(failure.message, /rollback incomplete/);
    assert.match(failure.message, /check the tree/);

    // The proof really was left behind by the failed rollback, so the diagnostic is not hiding it.
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source, "the source was never committed");
    assert.equal(existsSync(`${patch}.proof.json`), true, "the proof the rollback could not remove is still there");
    assert.equal(existsSync(`${patch}.audit.jsonl`), false);
    const out = JSON.parse(formatEditApplyJson(failure, 1)) as EditApplyReport;
    assert.equal(out.applied, false);
    assert.equal(out.exitCode, 1);
    assert.equal(out.status, "failed");
    assert.match(out.diagnostics[0]?.message ?? "", /rollback incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful edit has one source state, one proof file, and one audit line", async () => {
  const source = "# Old\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  const { errors, io } = capture();
  try {
    assert.equal(await main(["edit", "apply", patch, root], io), 0, errors.join("\n"));
    const after = readFileSync(join(root, "docs", "a.md"), "utf8");
    assert.equal(after, "# New\n\nBody\n");

    const proofPath = `${patch}.proof.json`;
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
      files: { path: string; before: string; after: string }[];
    };
    assert.equal(proof.files.length, 1, "exactly one proof entry");
    assert.deepEqual(proof.files[0], { path: "docs/a.md", before: hash(source), after: hash(after) });

    const ledgerPath = `${patch}.audit.jsonl`;
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, "exactly one audit line");
    const record = JSON.parse(lines[0]!) as {
      outcome: string;
      plan: { file: string; beforeHash: string; afterHash: string };
    };
    assert.equal(record.outcome, "applied");
    assert.equal(record.plan.file, "docs/a.md");
    assert.equal(record.plan.beforeHash, hash(source));
    assert.equal(record.plan.afterHash, hash(after));
    assert.equal(hash(after), proof.files[0]?.after, "the proof and ledger agree on the committed state");

    // Replaying the same patch is refused, appends nothing, and never reports applied.
    const again = capture();
    assert.equal(await main(["edit", "apply", patch, root, "--format", "json"], again.io), 1);
    const out = report(again.logs);
    assert.equal(out.applied, false);
    assert.equal(out.status, "failed");
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), after);
    assert.equal(readFileSync(proofPath, "utf8"), JSON.stringify(proof, null, 2) + "\n");
    assert.equal(readFileSync(ledgerPath, "utf8"), lines[0] + "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale input is refused by the transaction before any rename", async () => {
  const root = tree({ "a.txt": "one\n", "b.txt": "two\n" });
  const before = snapshot(root);
  try {
    await assert.rejects(
      commitArtifacts([
        { path: join(root, "a.txt"), content: "changed\n", expectedBeforeHash: hash("different\n") },
        { path: join(root, "b.txt"), content: "changed too\n" },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof TransactionError);
        assert.equal(error.code, "stale-input");
        return true;
      },
    );
    assert.deepEqual(snapshot(root), before);

    // A target changed between staging and commit is also refused, not overwritten.
    await assert.rejects(
      commitArtifacts(
        [
          { path: join(root, "a.txt"), content: "changed\n", expectedBeforeHash: hash("one\n") },
          { path: join(root, "b.txt"), content: "changed too\n" },
        ],
        {
          beforeCommit: () => {
            writeFileSync(join(root, "a.txt"), "external\n");
          },
        },
      ),
      (error: unknown) => error instanceof TransactionError && error.code === "stale-input",
    );
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "external\n", "the staged bytes were not written");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "two\n");
    assert.deepEqual(
      Object.keys(snapshot(root)).filter((path) => path.includes(".edit-")),
      [],
      "no staging folder is left",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run writes nothing and keeps its deterministic unified diff", async () => {
  const source = "# Old\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  const patch = patchAt(root, headingPatch(source));
  const before = snapshot(root);
  try {
    const first = capture();
    assert.equal(await main(["edit", "apply", patch, root, "--dry-run"], first.io), 0);
    const second = capture();
    assert.equal(await main(["edit", "apply", patch, root, "--dry-run"], second.io), 0);

    assert.deepEqual(snapshot(root), before, "no source, proof, ledger, lock, or staging residue");
    assert.equal(existsSync(`${patch}.proof.json`), false);
    assert.equal(existsSync(`${patch}.audit.jsonl`), false);
    assert.equal(first.logs.join("\n"), second.logs.join("\n"), "the diff is deterministic");
    assert.match(first.logs.join("\n"), /^--- a\/docs\/a\.md$/m);
    assert.match(first.logs.join("\n"), /^\+# New$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
