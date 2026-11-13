import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { EditApplyReport } from "../src/cli/edit-apply.ts";
import type { VerifyProofReport } from "../src/cli/edit-verify.ts";
import type { EditAuditRecord } from "../src/contracts/index.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";
import { planHeadingEdit } from "../src/edits/plan.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "edit-loop-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes `patch` as JSON at `root/name` and returns its absolute path. */
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

/** A patch that carries neither precondition, so the CLI must refuse it without the override. */
function uncheckedPatch(): Patch {
  return {
    span: { file: "docs/a.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
    replacement: "# New",
  };
}

/** SHA-256, as the proof and ledger write it. */
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One capture of a `main()` run: what went to stdout and what went to stderr. */
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
function report<T>(logs: readonly string[]): T {
  assert.equal(logs.length, 1, logs.join("\n"));
  return JSON.parse(logs[0]!) as T;
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

/** The audit records one ledger holds, in write order. */
function auditLines(path: string): EditAuditRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as EditAuditRecord);
}

/** The proof record as `edit apply` writes it. */
interface ProofDoc {
  readonly version: number;
  readonly date?: string;
  readonly files: readonly { readonly path: string; readonly before: string | null; readonly after: string | null }[];
}

test("the loop: a planned edit applies with a proof and ledger, then edit verify accepts it", async () => {
  const source = "# Guide\n\n## Old heading\n\nBody.\n";
  const after = "# Guide\n\n## New heading\n\nBody.\n";
  const root = tree({ "mizzen.yml": "title: T\n", "guide.md": source });
  try {
    // Plan the patch from the site model, exactly as an agent would before writing it.
    const { site } = await buildModel(root);
    const page = site.pages[0]!;
    const heading = page.headings.find((candidate) => candidate.id === "old-heading");
    assert.ok(heading !== undefined);
    const patch = planHeadingEdit({ site, source, url: page.url, headingId: heading.id, newText: "New heading" });
    assert.equal(patch.span.file, "guide.md");
    const patchPath = patchAt(root, patch);
    const proofPath = `${patchPath}.proof.json`;
    const ledgerPath = `${patchPath}.audit.jsonl`;

    // Apply it with a machine-readable result.
    const applied = capture();
    assert.equal(await main(["edit", "apply", patchPath, root, "--format", "json"], applied.io), 0);
    assert.deepEqual(applied.errors, []);
    const applyReport = report<EditApplyReport>(applied.logs);
    assert.equal(applyReport.status, "ok");
    assert.equal(applyReport.ok, true);
    assert.equal(applyReport.exitCode, 0);
    assert.equal(applyReport.applied, true);
    assert.equal(applyReport.dryRun, false);
    assert.equal(applyReport.siteRoot, root);
    assert.equal(applyReport.file, "guide.md");
    assert.equal(applyReport.proof, proofPath);
    assert.equal(applyReport.beforeHash, hash(source));
    assert.equal(applyReport.afterHash, hash(after));
    assert.deepEqual(applyReport.diagnostics, []);

    // The source, the proof, and the ledger agree on the committed bytes.
    assert.equal(readFileSync(join(root, "guide.md"), "utf8"), after);
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as ProofDoc;
    assert.equal(readFileSync(proofPath, "utf8"), `${JSON.stringify(proof, null, 2)}\n`);
    assert.equal(proof.version, 1);
    assert.deepEqual(proof.files, [{ path: "guide.md", before: hash(source), after: hash(after) }]);
    assert.equal("doctor" in proof, false);
    assert.equal("examples" in proof, false);

    const records = auditLines(ledgerPath);
    assert.equal(records.length, 1, "one applied plan appends one line");
    const record = records[0]!;
    assert.equal(record.outcome, "applied");
    assert.deepEqual(record.plan, {
      file: "guide.md",
      span: { line: 3, column: 1, endLine: 3, endColumn: 14 },
      beforeHash: hash(source),
      afterHash: hash(after),
    });
    assert.deepEqual(record.verification, { status: "skipped", checks: [] });

    // Verify the proof in both modes; verification never changes the source or the ledger.
    const verified = capture();
    assert.equal(await main(["edit", "verify", proofPath, "--site", root], verified.io), 0);
    assert.deepEqual(verified.errors, []);
    assert.match(verified.logs.join("\n"), /^ok: 1 file matches the proof\./m);

    const verifiedJson = capture();
    assert.equal(await main(["edit", "verify", proofPath, "--site", root, "--format", "json"], verifiedJson.io), 0);
    assert.deepEqual(verifiedJson.errors, []);
    const verifyReport = report<VerifyProofReport>(verifiedJson.logs);
    assert.equal(verifyReport.status, "ok");
    assert.equal(verifyReport.ok, true);
    assert.equal(verifyReport.exitCode, 0);
    assert.equal(verifyReport.proof, proofPath);
    assert.equal(verifyReport.siteRoot, root);
    assert.equal(verifyReport.files, 1);
    assert.equal(verifyReport.doctor, "not-recorded");
    assert.deepEqual(verifyReport.diagnostics, []);
    assert.equal(readFileSync(join(root, "guide.md"), "utf8"), after);
    assert.equal(readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale patch leaves the source, proof, and ledger byte-identical and appends nothing", async () => {
  const source = "# Old\n";
  const after = "# New\n";
  const root = tree({ "docs/a.md": source });
  const patchPath = patchAt(root, headingPatch(source));
  const proofPath = `${patchPath}.proof.json`;
  const ledgerPath = `${patchPath}.audit.jsonl`;
  try {
    assert.equal(await main(["edit", "apply", patchPath, root], capture().io), 0);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), after);
    const proofBefore = readFileSync(proofPath, "utf8");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    assert.equal(auditLines(ledgerPath).length, 1);

    // Same patch path, but computed for the bytes before the first edit.
    writeFileSync(patchPath, `${JSON.stringify(headingPatch(source), null, 2)}\n`);
    const stale = capture();
    assert.equal(await main(["edit", "apply", patchPath, root], stale.io), 1);
    assert.equal(stale.logs.length, 0);
    assert.match(stale.errors[0] ?? "", /hash|hashes to/);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), after);
    assert.equal(readFileSync(proofPath, "utf8"), proofBefore);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);

    // A second spelling of stale: the hash matches, the expected text does not.
    writeFileSync(patchPath, `${JSON.stringify(headingPatch(after, { expected: "# Old" }), null, 2)}\n`);
    const wrongText = capture();
    assert.equal(await main(["edit", "apply", patchPath, root], wrongText.io), 1);
    assert.match(wrongText.errors[0] ?? "", /expected/);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), after);
    assert.equal(readFileSync(proofPath, "utf8"), proofBefore);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);

    // The machine-readable refusal names the patch, never a success.
    const json = capture();
    assert.equal(await main(["edit", "apply", patchPath, root, "--format", "json"], json.io), 1);
    assert.deepEqual(json.errors, []);
    const refusal = report<EditApplyReport>(json.logs);
    assert.equal(refusal.status, "failed");
    assert.equal(refusal.ok, false);
    assert.equal(refusal.exitCode, 1);
    assert.equal(refusal.applied, false);
    assert.equal(refusal.diagnostics.length, 1);
    assert.equal(refusal.diagnostics[0]?.code, "edit.patch-refused");
    assert.equal(refusal.diagnostics[0]?.path, "docs/a.md");
    assert.equal(readFileSync(proofPath, "utf8"), proofBefore);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);

    // The one line is still the first edit's, so nothing was appended for either refusal.
    const records = auditLines(ledgerPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.plan.beforeHash, hash(source));
    assert.equal(records[0]?.plan.afterHash, hash(after));
    assert.equal(records[0]?.outcome, "applied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit verify exits 1 naming the changed file and never reports ok", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patchPath = patchAt(root, headingPatch(source));
  const proofPath = `${patchPath}.proof.json`;
  const ledgerPath = `${patchPath}.audit.jsonl`;
  try {
    assert.equal(await main(["edit", "apply", patchPath, root], capture().io), 0);
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    // A file the proof covers changes after the edit.
    writeFileSync(join(root, "docs", "a.md"), "changed after the proof\n");

    const text = capture();
    assert.equal(await main(["edit", "verify", proofPath, "--site", root], text.io), 1);
    assert.deepEqual(text.logs, [], "a failure is not printed as a success line");
    assert.match(text.errors[0] ?? "", /^mizzen: "docs\/a\.md" changed after the proof\./);

    const json = capture();
    assert.equal(await main(["edit", "verify", proofPath, "--site", root, "--format", "json"], json.io), 1);
    assert.deepEqual(json.errors, []);
    const out = report<VerifyProofReport>(json.logs);
    assert.equal(out.status, "failed");
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 1);
    assert.notEqual(out.status, "ok");
    assert.equal(out.doctor, "not-recorded");
    assert.deepEqual(out.diagnostics, [
      {
        code: "verify.file.changed",
        check: "hash",
        message: '"docs/a.md" changed after the proof.',
        path: "docs/a.md",
        expected: null,
        actual: null,
      },
    ]);

    // Verification is read-only: the changed bytes, the proof, and the ledger all stay as they were.
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "changed after the proof\n");
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed transaction leaves the source, proof, and ledger byte-for-byte identical", async () => {
  const source = "# Old\n";
  const priorProof = "prior proof bytes\n";
  const priorLedger = '{"prior":true}\n';
  const root = tree({ "docs/a.md": source, "records/.keep": "", "jobs/.keep": "" });
  const jobs = join(root, "jobs");
  const patchPath = patchAt(jobs, headingPatch(source));
  const proofPath = join(root, "records", "proof.json");
  const ledgerPath = `${patchPath}.audit.jsonl`;
  try {
    writeFileSync(proofPath, priorProof);
    writeFileSync(ledgerPath, priorLedger);
    const before = snapshot(root);

    // The CLI has no failure hook, so the reachable failure is an unwritable destination. The
    // transaction stages the proof in `records`, then cannot stage the ledger in `jobs`, and
    // aborts before any rename: every artifact must still hold its exact prior bytes.
    chmodSync(jobs, 0o555);
    try {
      const text = capture();
      assert.equal(
        await main(["edit", "apply", patchPath, root, "--proof", proofPath], text.io),
        1,
      );
      assert.deepEqual(text.logs, []);
      assert.match(text.errors[0] ?? "", /staging the edit failed/);
      assert.match(text.errors[0] ?? "", /nothing was written/);

      const json = capture();
      assert.equal(
        await main(["edit", "apply", patchPath, root, "--proof", proofPath, "--format", "json"], json.io),
        1,
      );
      assert.deepEqual(json.errors, []);
      const out = report<EditApplyReport>(json.logs);
      assert.equal(out.status, "failed");
      assert.equal(out.ok, false);
      assert.equal(out.exitCode, 1);
      assert.equal(out.applied, false);
      assert.equal(out.diagnostics[0]?.code, "edit.write-failed");
      assert.equal(out.diagnostics[0]?.path, "docs/a.md");

      assert.deepEqual(snapshot(root), before, "no artifact and no staging folder changed");
      assert.equal(readFileSync(proofPath, "utf8"), priorProof);
      assert.equal(readFileSync(ledgerPath, "utf8"), priorLedger);
      assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
      assert.deepEqual(
        Object.keys(snapshot(root)).filter((path) => path.includes(".edit-")),
        [],
      );
    } finally {
      chmodSync(jobs, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed step cannot emit a successful provenance result", async () => {
  // An unchecked patch, a malformed patch, and an escaping patch each write no proof and no ledger,
  // and each machine-readable result carries a failure status.
  const uncheckedRoot = tree({ "docs/a.md": "# Old\n" });
  try {
    const patchPath = patchAt(uncheckedRoot, uncheckedPatch());
    const run = capture();
    assert.equal(await main(["edit", "apply", patchPath, uncheckedRoot, "--format", "json"], run.io), 2);
    const out = report<EditApplyReport>(run.logs);
    assert.notEqual(out.status, "ok");
    assert.equal(out.ok, false);
    assert.equal(out.applied, false);
    assert.equal(existsSync(`${patchPath}.proof.json`), false);
    assert.equal(existsSync(`${patchPath}.audit.jsonl`), false);
  } finally {
    rmSync(uncheckedRoot, { recursive: true, force: true });
  }

  const malformedRoot = tree({ "docs/a.md": "# Old\n" });
  try {
    const patchPath = join(malformedRoot, "bad.json");
    writeFileSync(patchPath, "not a patch");
    const run = capture();
    assert.equal(await main(["edit", "apply", patchPath, malformedRoot, "--format", "json"], run.io), 2);
    const out = report<EditApplyReport>(run.logs);
    assert.equal(out.status, "invalid");
    assert.equal(out.ok, false);
    assert.equal(out.applied, false);
    assert.equal(existsSync(`${patchPath}.proof.json`), false);
    assert.equal(existsSync(`${patchPath}.audit.jsonl`), false);
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n" });
  try {
    const site = join(parent, "site");
    const patchPath = patchAt(parent, {
      span: { file: "../outside.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
      expected: "# Old",
      replacement: "# New",
    });
    const run = capture();
    assert.equal(await main(["edit", "apply", patchPath, site, "--format", "json"], run.io), 1);
    const out = report<EditApplyReport>(run.logs);
    assert.equal(out.status, "failed");
    assert.equal(out.ok, false);
    assert.equal(out.applied, false);
    assert.equal(out.diagnostics[0]?.code, "edit.path-escape");
    assert.equal(existsSync(`${patchPath}.proof.json`), false);
    assert.equal(existsSync(`${patchPath}.audit.jsonl`), false);
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  // A verification failure adds no ledger line, and the proof still describes the committed bytes,
  // not the tampered tree; the ledger's only record claims no verification at all.
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    const patchPath = patchAt(root, headingPatch("# Old\n"));
    const proofPath = `${patchPath}.proof.json`;
    const ledgerPath = `${patchPath}.audit.jsonl`;
    assert.equal(await main(["edit", "apply", patchPath, root], capture().io), 0);
    const proofBefore = readFileSync(proofPath, "utf8");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    writeFileSync(join(root, "docs", "a.md"), "tampered\n");

    const run = capture();
    assert.equal(await main(["edit", "verify", proofPath, "--site", root, "--format", "json"], run.io), 1);
    const out = report<VerifyProofReport>(run.logs);
    assert.equal(out.status, "failed");
    assert.equal(out.ok, false);
    assert.equal(readFileSync(proofPath, "utf8"), proofBefore, "verification never rewrites the proof");
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore, "verification never appends a ledger line");

    const proof = JSON.parse(proofBefore) as ProofDoc;
    assert.notEqual(proof.files[0]?.after, hash("tampered\n"), "the proof does not claim the tampered bytes");
    const records = auditLines(ledgerPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "applied");
    assert.deepEqual(records[0]?.verification, { status: "skipped", checks: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchecked patch needs --allow-unchecked before the CLI writes anything", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const patchPath = patchAt(root, uncheckedPatch());
  try {
    const refused = capture();
    assert.equal(await main(["edit", "apply", patchPath, root], refused.io), 2);
    assert.deepEqual(refused.logs, []);
    assert.match(refused.errors[0] ?? "", /--allow-unchecked/);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), source);
    assert.equal(existsSync(`${patchPath}.proof.json`), false);
    assert.equal(existsSync(`${patchPath}.audit.jsonl`), false);

    const allowed = capture();
    assert.equal(await main(["edit", "apply", patchPath, root, "--allow-unchecked"], allowed.io), 0, allowed.errors.join("\n"));
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "# New\n");
    assert.ok(existsSync(`${patchPath}.proof.json`));
    assert.ok(existsSync(`${patchPath}.audit.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an escaping span is refused and a malformed patch is a usage error", async () => {
  // A lexical escape: span.file leaves the site root.
  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n" });
  try {
    const site = join(parent, "site");
    const patchPath = patchAt(parent, {
      span: { file: "../outside.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
      expected: "# Old",
      replacement: "# New",
    });
    const run = capture();
    assert.equal(await main(["edit", "apply", patchPath, site], run.io), 1);
    assert.match(run.errors[0] ?? "", /outside the site root/);
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(existsSync(`${patchPath}.proof.json`), false);

    // A symlink whose real target leaves the site root is refused before its source is read.
    symlinkSync(join(parent, "outside.md"), join(site, "docs", "link.md"));
    const linkPath = patchAt(
      parent,
      {
        span: { file: "docs/link.md", line: 1, column: 1, endLine: 1, endColumn: 5 },
        expected: "# Old",
        replacement: "# New",
        beforeHash: hashSource("# Old\n"),
      },
      "link-patch.json",
    );
    const linked = capture();
    assert.equal(await main(["edit", "apply", linkPath, site], linked.io), 1);
    assert.match(linked.errors[0] ?? "", /resolves outside the site root/);
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(existsSync(`${linkPath}.proof.json`), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  // A patch that is not JSON, and one without span.file, are both usage errors (exit 2).
  const root = tree({ "docs/a.md": "# Old\n" });
  try {
    const notJson = join(root, "bad.json");
    writeFileSync(notJson, "nope");
    const first = capture();
    assert.equal(await main(["edit", "apply", notJson, root], first.io), 2);
    assert.match(first.errors[0] ?? "", /not JSON/);
    assert.equal(existsSync(`${notJson}.proof.json`), false);

    const noFile = join(root, "no-file.json");
    writeFileSync(
      noFile,
      `${JSON.stringify({ span: { line: 1, column: 1, endLine: 1, endColumn: 5 }, replacement: "# New" }, null, 2)}\n`,
    );
    const second = capture();
    assert.equal(await main(["edit", "apply", noFile, root], second.io), 2);
    assert.match(second.errors[0] ?? "", /span\.file/);
    assert.equal(existsSync(`${noFile}.proof.json`), false);
    assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "# Old\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
