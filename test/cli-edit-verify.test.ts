import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, parseArgs, usage } from "../src/cli/index.ts";
import { verifyProof, verifyProofMessage } from "../src/cli/edit-verify.ts";
import { writeProof, type ProofLevel } from "../src/edits/proof.ts";

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

/** Writes a proof at `<root>/.slipway/proof.json` for `entries` and returns its path. */
async function record(root: string, entries: readonly Entry[], doctor?: ProofLevel): Promise<string> {
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
    ...(doctor === undefined ? {} : { doctor: { level: doctor } }),
    out: ".slipway/proof.json",
  });
  return join(root, ".slipway", "proof.json");
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

test("parseArgs: edit verify takes a proof, a site root, and --doctor", () => {
  assert.deepEqual(parseArgs(["edit", "verify", "proof.json"]), {
    options: { command: "edit-verify", proof: "proof.json", site: ".", doctor: false },
  });
  assert.deepEqual(parseArgs(["edit", "verify", "proof.json", "--site", "site", "--doctor"]), {
    options: { command: "edit-verify", proof: "proof.json", site: "site", doctor: true },
  });
  assert.deepEqual(parseArgs(["edit", "--help"]), { help: true });
  assert.equal("error" in parseArgs(["edit"]), true);
  assert.equal("error" in parseArgs(["edit", "nope"]), true);
  assert.equal("error" in parseArgs(["edit", "verify"]), true);
  assert.equal("error" in parseArgs(["edit", "verify", "proof.json", "--out", "x"]), true);
  assert.equal("error" in parseArgs(["edit", "verify", "a", "b"]), true);
  assert.match(usage, /edit verify <proof\.json>/);
  assert.match(usage, /--doctor/);
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

test("a file changed after the proof exits 1 and names the first path in order", async () => {
  const root = tree({ "a.md": "one\n", "z.md": "two\n" });
  try {
    const proof = await record(root, [
      { path: "a.md", after: "one\n" },
      { path: "z.md", after: "two\n" },
    ]);
    // Change both: the report must name the earlier path, not whichever was read first.
    writeFileSync(join(root, "a.md"), "changed\n");
    writeFileSync(join(root, "z.md"), "changed too\n");

    const { errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root], io), 1);
    assert.deepEqual(errors, ['mizzen: "a.md" changed after the proof.']);
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
    const malformed = join(root, ".slipway", "proof.json");
    mkdirSync(dirname(malformed), { recursive: true });
    writeFileSync(malformed, '{"version":1,"files":[');
    const bad = capture();
    assert.equal(await main(["edit", "verify", malformed, "--site", root], bad.io), 2);
    assert.deepEqual(bad.logs, []);
    assert.match(bad.errors[0] ?? "", /is not a valid proof: it is not JSON\./);

    const wrongVersion = join(root, ".slipway", "wrong.json");
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
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], "L2");
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

test("--doctor compares the recorded level with a doctor run as a command", async () => {
  const root = tree({ "a.md": "one\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], "L2");

    const fake = join(scratch, "fake-doctor.ts");
    writeFileSync(fake, 'process.stdout.write(JSON.stringify({ level: "L1" }));\n');
    const mismatch = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: process.execPath, prefix: [fake] },
    });
    assert.equal(mismatch.ok, false);
    assert.deepEqual(mismatch.failure, { kind: "doctor", expected: "L2", actual: "L1" });
    assert.match(verifyProofMessage(mismatch), /doctor level is L1, not the recorded L2/);

    writeFileSync(fake, 'process.stdout.write(JSON.stringify({ level: "L2" }));\n');
    const match = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: process.execPath, prefix: [fake] },
    });
    assert.equal(match.ok, true);
    assert.equal(match.doctor, "matched");
    assert.equal(verifyProofMessage(match), "ok: 1 file matches the proof; the doctor level matches.");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a doctor that cannot run is a usage failure, not a matching proof", async () => {
  const root = tree({ "a.md": "one\n" });
  try {
    const proof = await record(root, [{ path: "a.md", after: "one\n" }], "L2");
    const result = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: { command: join(root, "does-not-exist") },
    });
    assert.equal(result.ok, false);
    assert.equal(result.doctor, "unavailable");
    assert.equal(result.failure?.kind, "doctor-unavailable");
    assert.match(verifyProofMessage(result), /could not run the doctor/);
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
