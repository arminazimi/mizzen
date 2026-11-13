import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  DOCTOR_TIMEOUT_MS,
  formatVerifyProofJson,
  verifyProof,
  verifyProofMessage,
  type VerifyProofReport,
  type VerifyProofResult,
} from "../src/cli/edit-verify.ts";
import { writeProof, type ProofFinding } from "../src/edits/proof.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "edit-verify-timeout-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes a proof for `docs/a.md` with `findings` recorded, and returns its path. */
async function doctorProof(root: string, findings: readonly ProofFinding[]): Promise<string> {
  await writeProof({
    siteRoot: root,
    files: ["docs/a.md"],
    before: { "docs/a.md": "before\n" },
    after: { "docs/a.md": "after\n" },
    doctor: { level: "L2", findings },
    out: ".mizzen/proof.json",
  });
  return join(root, ".mizzen", "proof.json");
}

/** Writes a doctor script that runs `body` and returns the command that runs it. */
function fakeDoctor(scratch: string, body: string) {
  const file = join(scratch, "fake-doctor.ts");
  writeFileSync(file, body);
  return { command: process.execPath, prefix: [file] };
}

/** The one machine-readable document a report holds. */
function report(result: VerifyProofResult, exitCode: number): VerifyProofReport {
  return JSON.parse(formatVerifyProofJson(result, exitCode)) as VerifyProofReport;
}

const FINDINGS: readonly ProofFinding[] = [{ id: "ae.meta", severity: "warning", message: "Missing description." }];

/** What a matching doctor prints for {@link FINDINGS}. */
const MATCHING_REPORT = JSON.stringify({
  version: 1,
  diagnostics: [{ id: "ae.meta", severity: "warning", message: "Missing description." }],
});

test("a doctor that never exits is unavailable within the deadline, never a match", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-timeout-doctor-"));
  try {
    const proof = await doctorProof(root, FINDINGS);
    // It prints a report that would match, then hangs: the deadline must win over its output.
    const command = fakeDoctor(
      scratch,
      `process.stdout.write(${JSON.stringify(MATCHING_REPORT)});\nsetTimeout(() => {}, 60_000);\n`,
    );

    const started = Date.now();
    const result = await verifyProof({ proof, siteRoot: root, doctor: true, doctorCommand: command, doctorTimeoutMs: 250 });
    assert.ok(Date.now() - started < 10_000, "verify returned instead of waiting for the doctor to exit");

    assert.equal(result.ok, false);
    assert.equal(result.doctor, "unavailable");
    assert.deepEqual(result.failure, {
      kind: "doctor-unavailable",
      reason: "unavailable",
      message: "it did not finish within 250ms",
    });

    // The text and the JSON name the same outcome, and neither can be read as a matching proof.
    const message = verifyProofMessage(result);
    assert.equal(message, "could not verify the doctor: it did not finish within 250ms.");
    const out = report(result, 2);
    assert.equal(out.status, "invalid");
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 2);
    assert.equal(out.doctor, "unavailable");
    assert.deepEqual(out.diagnostics, [
      { code: "verify.doctor.unavailable", check: "doctor", message, path: null, expected: null, actual: null },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the deadline leaves successful and malformed doctor outcomes unchanged", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-timeout-doctor-"));
  try {
    const proof = await doctorProof(root, FINDINGS);

    const match = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: fakeDoctor(scratch, `process.stdout.write(${JSON.stringify(MATCHING_REPORT)});\n`),
      doctorTimeoutMs: 5_000,
    });
    assert.equal(match.ok, true);
    assert.equal(match.doctor, "matched");
    assert.equal(verifyProofMessage(match), "ok: 1 file matches the proof; the doctor findings match.");

    const malformed = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: fakeDoctor(scratch, `process.stdout.write("{not json");\n`),
      doctorTimeoutMs: 5_000,
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.doctor, "unavailable");
    assert.match(verifyProofMessage(malformed), /could not verify the doctor: .*not JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the default deadline is documented and bounded", () => {
  assert.equal(DOCTOR_TIMEOUT_MS, 30_000);
});
