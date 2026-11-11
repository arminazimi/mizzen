import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, parseArgs, usage } from "../src/cli/index.ts";
import {
  formatVerifyProofJson,
  verifyProof,
  verifyProofMessage,
  type VerifyProofReport,
} from "../src/cli/edit-verify.ts";
import { writeProof, type ProofDoctor } from "../src/edits/proof.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "edit-verify-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** One entry of a proof a test writes: what the file holds now, and optionally that it was absent before. */
interface Entry {
  readonly path: string;
  readonly after: string | null;
  readonly before?: string | null;
}

/** Writes a proof at `<root>/.mizzen/proof.json` for `entries` and returns its path. */
async function record(root: string, entries: readonly Entry[], doctor?: ProofDoctor): Promise<string> {
  const files = entries.map((entry) => entry.path);
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const entry of entries) {
    before[entry.path] = entry.before === undefined ? "before\n" : entry.before;
    after[entry.path] = entry.after;
  }
  await writeProof({
    siteRoot: root,
    files,
    before,
    after,
    ...(doctor === undefined ? {} : { doctor }),
    out: ".mizzen/proof.json",
  });
  return join(root, ".mizzen", "proof.json");
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
function report(logs: readonly string[]): VerifyProofReport {
  assert.equal(logs.length, 1, logs.join("\n"));
  return JSON.parse(logs[0]!) as VerifyProofReport;
}

test("parseArgs: edit verify takes a proof, a site root, --doctor, and --format", () => {
  assert.deepEqual(parseArgs(["edit", "verify", "proof.json"]), {
    options: { command: "edit-verify", proof: "proof.json", site: ".", doctor: false, format: "text" },
  });
  assert.deepEqual(parseArgs(["edit", "verify", "proof.json", "--site", "site", "--doctor"]), {
    options: { command: "edit-verify", proof: "proof.json", site: "site", doctor: true, format: "text" },
  });
  assert.deepEqual(parseArgs(["edit", "verify", "proof.json", "--format", "json"]), {
    options: { command: "edit-verify", proof: "proof.json", site: ".", doctor: false, format: "json" },
  });
  assert.deepEqual(parseArgs(["edit", "--help"]), { help: true });
  assert.equal("error" in parseArgs(["edit"]), true);
  assert.equal("error" in parseArgs(["edit", "nope"]), true);
  assert.equal("error" in parseArgs(["edit", "verify"]), true);
  assert.equal("error" in parseArgs(["edit", "verify", "proof.json", "--out", "x"]), true);
  assert.equal("error" in parseArgs(["edit", "verify", "proof.json", "--format", "sarif"]), true);
  assert.equal("error" in parseArgs(["edit", "verify", "a", "b"]), true);
  assert.match(usage, /edit verify <proof\.json>/);
  assert.match(usage, /--doctor/);
  assert.match(usage, /text or json for edit apply and edit verify/);
});

test("an untouched edit exits 0 and names no file", async () => {
  const root = tree({ "docs/a.md": "alpha\n", "docs/b.md": "beta\n" });
  try {
    const proof = await record(root, [
      { path: "docs/a.md", after: "alpha\n" },
      { path: "docs/b.md", after: "beta\n" },
    ]);
    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 0);
    assert.deepEqual(errors, []);
    assert.equal(logs[0], "ok: 2 files match the proof. The proof records no doctor level.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file changed after the proof exits 1 and names every path in order", async () => {
  const root = tree({ "a.md": "one\n", "z.md": "two\n" });
  try {
    const proof = await record(root, [
      { path: "a.md", after: "one\n" },
      { path: "z.md", after: "two\n" },
    ]);
    // Change both: the report must name both, in path order, not stop at the first.
    writeFileSync(join(root, "a.md"), "changed\n");
    writeFileSync(join(root, "z.md"), "changed too\n");

    const { errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 1);
    assert.deepEqual(errors, [
      'mizzen: "a.md" changed after the proof. "z.md" changed after the proof.',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file missing after the proof exits 1 and says it is missing", async () => {
  const root = tree({ "docs/a.md": "alpha\n" });
  try {
    const proof = await record(root, [{ path: "docs/a.md", after: "alpha\n" }]);
    rmSync(join(root, "docs/a.md"));

    const { errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 1);
    assert.deepEqual(errors, ['mizzen: "docs/a.md" is missing: the proof records it after the edit.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file the proof records as deleted but is present again exits 1 as extra", async () => {
  const root = tree({ "docs/gone.md": "still here\n" });
  try {
    const proof = await record(root, [{ path: "docs/gone.md", before: "was here\n", after: null }]);

    const { errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 1);
    assert.deepEqual(errors, ['mizzen: "docs/gone.md" is extra: the proof records it absent after the edit.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed or absent proof exits 2", async () => {
  const root = tree({ "a.md": "one\n" });
  try {
    const malformed = join(root, ".mizzen", "proof.json");
    mkdirSync(dirname(malformed), { recursive: true });
    writeFileSync(malformed, '{"version":1,"files":[');
    const bad = capture();
    assert.equal(await main(["edit", "verify", malformed, "--site", root], bad.io), 2);
    assert.deepEqual(bad.logs, []);
    assert.match(bad.errors[0] ?? "", /is not a valid proof: it is not JSON\./);

    const wrongVersion = join(root, ".mizzen", "wrong.json");
    writeFileSync(wrongVersion, '{"version":2,"files":[]}');
    const version = capture();
    assert.equal(await main(["edit", "verify", wrongVersion, "--site", root], version.io), 2);
    assert.match(version.errors[0] ?? "", /its version is 2, not 1\./);

    const absent = capture();
    assert.equal(await main(["edit", "verify", join(root, "no-proof.json"), "--site", root], absent.io), 2);
    assert.match(absent.errors[0] ?? "", /is not a valid proof: it does not exist\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without --doctor the hashes are checked and the doctor is reported as not run", async () => {
  const root = tree({ "a.md": "one\n" });
  try {
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], { level: "L2" });
    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 0);
    assert.deepEqual(errors, []);
    assert.equal(logs[0], "ok: 1 file matches the proof. The doctor check was not run; pass --doctor to rerun it.");

    const result = await verifyProof({ proof, siteRoot: root });
    assert.equal(result.doctor, "not-run");
    assert.match(verifyProofMessage(result), /doctor check was not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--doctor compares recorded findings with the doctor's diagnostics report", async () => {
  const root = tree({ "a.md": "one\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const findings = [{ id: "ae.meta", severity: "warning" as const, message: "Missing description." }];
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], { level: "L2", findings });

    const fake = join(scratch, "fake-doctor.ts");
    writeFileSync(
      fake,
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          version: 1,
          diagnostics: [{ id: "ae.meta", severity: "error", message: "Missing description." }],
        }),
      )});\n`,
    );
    const mismatch = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: process.execPath, prefix: [fake] },
    });
    assert.equal(mismatch.ok, false);
    assert.deepEqual(mismatch.failure, {
      kind: "doctor",
      recorded: 1,
      actual: 1,
      difference: 'the recorded finding "ae.meta" is not in the doctor report',
    });
    assert.match(verifyProofMessage(mismatch), /doctor findings do not match/);

    writeFileSync(
      fake,
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          version: 1,
          diagnostics: [{ id: "ae.meta", severity: "warning", message: "Missing description." }],
        }),
      )});\n`,
    );
    const match = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: process.execPath, prefix: [fake] },
    });
    assert.equal(match.ok, true);
    assert.equal(match.doctor, "matched");
    assert.equal(verifyProofMessage(match), "ok: 1 file matches the proof; the doctor findings match.");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a doctor that cannot run is a usage failure, not a matching proof", async () => {
  const root = tree({ "a.md": "one\n" });
  try {
    const findings = [{ id: "ae.meta", severity: "warning" as const, message: "Missing description." }];
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], { level: "L2", findings });
    const result = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: join(root, "does-not-exist") },
    });
    assert.equal(result.ok, false);
    assert.equal(result.doctor, "unavailable");
    assert.equal(result.failure?.kind, "doctor-unavailable");
    assert.match(verifyProofMessage(result), /could not verify the doctor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a matching proof reports the files it checked", async () => {
  const root = tree({ "a.md": "one\n", "b.md": "two\n" });
  try {
    const proof = await record(root, [
      { path: "a.md", after: readFileSync(join(root, "a.md"), "utf8") },
      { path: "b.md", after: readFileSync(join(root, "b.md"), "utf8") },
    ]);
    const result = await verifyProof({ proof, siteRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.files, 2);
    assert.equal(result.failure, undefined);
    assert.equal(result.doctor, "not-recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--format json reports a matching proof as ok with no diagnostics", async () => {
  const root = tree({ "docs/a.md": "alpha\n", "docs/b.md": "beta\n" });
  try {
    const proof = await record(root, [
      { path: "docs/a.md", after: "alpha\n" },
      { path: "docs/b.md", after: "beta\n" },
    ]);
    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root, "--format", "json"], io), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(report(logs), {
      version: 1,
      command: "edit.verify",
      status: "ok",
      ok: true,
      exitCode: 0,
      proof,
      siteRoot: root,
      files: 2,
      doctor: "not-recorded",
      diagnostics: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--format json names the failed check and path when a file changed", async () => {
  const root = tree({ "docs/a.md": "alpha\n" });
  try {
    const proof = await record(root, [{ path: "docs/a.md", after: "alpha\n" }]);
    writeFileSync(join(root, "docs/a.md"), "changed\n");
    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root, "--format", "json"], io), 1);
    // A failure is still a document on stdout, so an agent always has something to parse.
    assert.deepEqual(errors, []);
    const out = report(logs);
    assert.equal(out.status, "failed");
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 1);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--format json reports an unreadable proof as invalid and names the proof file", async () => {
  const root = tree({ "a.md": "one\n" });
  try {
    const proof = join(root, "no-proof.json");
    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root, "--format", "json"], io), 2);
    assert.deepEqual(errors, []);
    const out = report(logs);
    assert.equal(out.status, "invalid");
    assert.equal(out.exitCode, 2);
    assert.equal(out.ok, false);
    assert.equal(out.diagnostics[0]?.code, "verify.proof-invalid");
    assert.equal(out.diagnostics[0]?.check, "proof");
    assert.equal(out.diagnostics[0]?.path, proof);
    assert.match(out.diagnostics[0]?.message ?? "", /it does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatVerifyProofJson names a doctor mismatch's difference and the failed check", async () => {
  const root = tree({ "a.md": "one\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-json-"));
  try {
    const findings = [{ id: "ae.meta", severity: "warning" as const, message: "Missing description." }];
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], { level: "L2", findings });
    const fake = join(scratch, "fake-doctor.ts");
    writeFileSync(
      fake,
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          version: 1,
          diagnostics: [{ id: "ae.meta", severity: "error", message: "Missing description." }],
        }),
      )});\n`,
    );
    const result = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: process.execPath, prefix: [fake] },
    });
    const out = JSON.parse(formatVerifyProofJson(result, 1)) as VerifyProofReport;
    assert.equal(out.status, "failed");
    assert.deepEqual(out.diagnostics, [
      {
        code: "verify.doctor.mismatch",
        check: "doctor",
        message:
          'the doctor findings do not match the proof: the recorded finding "ae.meta" is not in the doctor report.',
        path: null,
        expected: null,
        actual: null,
      },
    ]);

    const unavailable = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: join(root, "does-not-exist") },
    });
    const invalid = JSON.parse(formatVerifyProofJson(unavailable, 2)) as VerifyProofReport;
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.diagnostics[0]?.code, "verify.doctor.unavailable");
    assert.equal(invalid.diagnostics[0]?.check, "doctor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
