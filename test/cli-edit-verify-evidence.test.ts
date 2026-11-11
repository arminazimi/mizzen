import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import {
  formatVerifyProofJson,
  verifyProof,
  verifyProofMessage,
  type VerifyProofReport,
} from "../src/cli/edit-verify.ts";
import type { ProofFinding, ProofSpan } from "../src/edits/proof.ts";
import { writeProof } from "../src/edits/proof.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "edit-verify-evidence-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** SHA-256 of a text or bytes, as a proof records it. */
function hash(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One raw file entry of a hand-written proof, so a test can forge spans and hashes. */
interface RawEntry {
  readonly path: string;
  readonly after: string | null;
  readonly before?: string | null;
  readonly spans?: readonly ProofSpan[];
}

/** Writes a proof verbatim at `<root>/.mizzen/proof.json` and returns its path. */
function rawProof(root: string, files: readonly RawEntry[], doctor?: object): string {
  const proof = join(root, ".mizzen", "proof.json");
  mkdirSync(dirname(proof), { recursive: true });
  writeFileSync(
    proof,
    JSON.stringify(
      {
        version: 1,
        files: files.map((entry) => ({
          path: entry.path,
          before: entry.before === undefined ? null : entry.before,
          after: entry.after,
          ...(entry.spans === undefined ? {} : { spans: entry.spans }),
        })),
        ...(doctor === undefined ? {} : { doctor }),
      },
      null,
      2,
    ),
  );
  return proof;
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

/** Writes a fake doctor that prints `body`, and returns the command that runs it. */
function fakeDoctor(scratch: string, body: unknown) {
  const file = join(scratch, "fake-doctor.ts");
  writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});\n`);
  return { command: process.execPath, prefix: [file] };
}

test("a valid proof with exact spans verifies: Unicode code-point columns and CRLF sources", async () => {
  // Line 1 has an astral character (one code point, two UTF-16 units); the file uses CRLF.
  const content = "a😀b\r\ncafé\r\n";
  const root = tree({ "docs/u.md": content, "docs/real.md": "inside\n" });
  try {
    symlinkSync(join(root, "docs/real.md"), join(root, "docs/link.md"));
    const proof = await writeProof({
      siteRoot: root,
      files: ["docs/u.md", "docs/link.md"],
      before: { "docs/u.md": "old\r\n", "docs/link.md": null },
      after: { "docs/u.md": content, "docs/link.md": "inside\n" },
      spans: {
        "docs/u.md": [
          // "😀b" is columns 2-3, not 2-4.
          { line: 1, column: 2, endLine: 1, endColumn: 3 },
          { line: 2, column: 1, endLine: 2, endColumn: 4 },
        ],
      },
      out: ".mizzen/proof.json",
    });
    const path = join(root, ".mizzen", "proof.json");

    const result = await verifyProof({ proof: path, siteRoot: root });
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.files, 2);

    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", path, "--site", root], io), 0);
    assert.deepEqual(errors, []);
    assert.match(logs[0] ?? "", /^ok: 2 files match the proof/);
    assert.equal(proof.files.find((file) => file.path === "docs/u.md")?.spans?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every file mismatch is reported once, in path order, with a distinct stable diagnostic", async () => {
  const root = tree({
    "a-changed.md": "actually changed\n",
    "b-missing.md": "expected\n",
    "c-extra.md": "still here\n",
    "d-span.md": "alpha\nworld\n",
    "z-escape.md": "placeholder\n",
  });
  const outside = tree({ "outside.md": "outside the site\n" });
  try {
    rmSync(join(root, "b-missing.md"));
    rmSync(join(root, "z-escape.md"));
    symlinkSync(join(outside, "outside.md"), join(root, "z-escape.md"));

    const proof = rawProof(root, [
      // Written out of order so the check proves it sorts by path.
      {
        path: "z-escape.md",
        after: hash("outside the site\n"),
        spans: [],
      },
      {
        path: "d-span.md",
        after: hash("alpha\nworld\n"),
        spans: [
          // The hash is "world"'s, but the span points at "alpha": the text moved.
          { line: 1, column: 1, endLine: 1, endColumn: 5, hash: hash("world") },
          // No such text anywhere in the file.
          { line: 2, column: 1, endLine: 2, endColumn: 5, hash: hash("xxxxx") },
          // Past the last line.
          { line: 9, column: 1, endLine: 9, endColumn: 5, hash: hash("world") },
        ],
      },
      { path: "a-changed.md", after: hash("expected\n") },
      { path: "c-extra.md", after: null },
      { path: "b-missing.md", after: hash("expected\n") },
    ]);

    const result = await verifyProof({ proof, siteRoot: root });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failures.map((failure) => (failure.kind === "file" ? failure.state : failure.kind === "span" ? failure.state : failure.kind)),
      ["changed", "missing", "extra", "moved", "hash", "range", "escape"],
    );

    const { logs, errors, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root, "--format", "json"], io), 1);
    assert.deepEqual(errors, []);
    const out = report(logs);
    assert.equal(out.status, "failed");
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(
      out.diagnostics.map((diagnostic) => diagnostic.code),
      [
        "verify.file.changed",
        "verify.file.missing",
        "verify.file.extra",
        "verify.span.moved",
        "verify.span.hash",
        "verify.span.range",
        "verify.path.escape",
      ],
    );
    assert.deepEqual(
      out.diagnostics.map((diagnostic) => diagnostic.path),
      ["a-changed.md", "b-missing.md", "c-extra.md", "d-span.md", "d-span.md", "d-span.md", "z-escape.md"],
    );

    // Each case has its own sentence, and the text mode names all of them.
    const messages = out.diagnostics.map((diagnostic) => diagnostic.message);
    assert.equal(new Set(messages).size, messages.length);
    assert.match(messages[3]!, /moved: its text is now at 2:1-2:5/);
    const text = verifyProofMessage(result);
    for (const sentence of messages) assert.ok(text.includes(sentence), `${text} is missing ${sentence}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a changed file's spans are not checked against text that is already gone", async () => {
  const root = tree({ "docs/a.md": "changed\n" });
  try {
    const proof = rawProof(root, [
      {
        path: "docs/a.md",
        after: hash("expected\n"),
        spans: [{ line: 1, column: 1, endLine: 1, endColumn: 4, hash: hash("nope") }],
      },
    ]);
    const result = await verifyProof({ proof, siteRoot: root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [{ kind: "file", path: "docs/a.md", state: "changed" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a proof with a malformed span is invalid and exits 2", async () => {
  const root = tree({ "docs/a.md": "alpha\n" });
  try {
    const proof = rawProof(root, [
      {
        path: "docs/a.md",
        after: hash("alpha\n"),
        spans: [{ line: 0, column: 1, endLine: 1, endColumn: 1, hash: hash("a") }],
      },
    ]);
    const { logs, io } = capture();
    assert.equal(await main(["edit", "verify", proof, "--site", root, "--format", "json"], io), 2);
    const out = report(logs);
    assert.equal(out.status, "invalid");
    assert.equal(out.diagnostics[0]?.code, "verify.proof-invalid");
    assert.match(out.diagnostics[0]?.message ?? "", /not a 1-based positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A proof whose doctor record keeps `findings`; the file itself is valid. */
async function doctorProof(root: string, doctor?: { level: "L2" | null; findings?: readonly ProofFinding[] }): Promise<string> {
  await writeProof({
    siteRoot: root,
    files: ["docs/a.md"],
    before: { "docs/a.md": "before\n" },
    after: { "docs/a.md": "after\n" },
    ...(doctor === undefined ? {} : { doctor }),
    out: ".mizzen/proof.json",
  });
  return join(root, ".mizzen", "proof.json");
}

test("doctor success needs recorded findings that match the current diagnostics report", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const findings: ProofFinding[] = [
      { id: "ae.meta", severity: "warning", message: "Missing description.", file: "docs/a.md", line: 1, column: 1 },
      // A projection without a location still matches a diagnostic that has one.
      { id: "ae.links", severity: "error", message: "No page at /missing/." },
    ];
    const proof = await doctorProof(root, { level: "L2", findings });
    const command = fakeDoctor(scratch, {
      version: 1,
      diagnostics: [
        { id: "ae.meta", severity: "warning", message: "Missing description.", pos: { file: "docs/a.md", line: 1, column: 1, endLine: 1 } },
        { id: "ae.links", severity: "error", message: "No page at /missing/.", pos: { file: "docs/other.md", line: 4, column: 2, endLine: 4 } },
      ],
    });

    const match = await verifyProof({ proof, siteRoot: root, doctor: true, doctorCommand: command });
    assert.equal(match.ok, true);
    assert.equal(match.doctor, "matched");
    assert.match(verifyProofMessage(match), /the doctor findings match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an info finding from a skipped doctor check is kept and matches verify --doctor", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const skipped = "The links check did not run because its input was missing.";
    const findings: ProofFinding[] = [
      { id: "doctor.check-skipped", severity: "info", message: skipped },
      { id: "ae.meta", severity: "warning", message: "Missing description.", file: "docs/a.md", line: 1, column: 1 },
    ];
    const proof = await doctorProof(root, { level: "L2", findings });
    const command = fakeDoctor(scratch, {
      version: 1,
      diagnostics: [
        { id: "doctor.check-skipped", severity: "info", message: skipped },
        {
          id: "ae.meta",
          severity: "warning",
          message: "Missing description.",
          pos: { file: "docs/a.md", line: 1, column: 1, endLine: 1 },
        },
      ],
    });

    const written = JSON.parse(readFileSync(proof, "utf8")) as {
      doctor: { findings: readonly ProofFinding[] };
    };
    assert.deepEqual(
      written.doctor.findings.map((finding) => [finding.id, finding.severity]),
      [
        ["doctor.check-skipped", "info"],
        ["ae.meta", "warning"],
      ],
      "the info finding is written to the proof, not dropped",
    );

    const matched = await verifyProof({ proof, siteRoot: root, doctor: true, doctorCommand: command });
    assert.equal(matched.ok, true);
    assert.deepEqual(matched.failures, []);
    assert.equal(matched.doctor, "matched", "an info finding is evidence, not a mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("doctor findings that changed are a mismatch, never a match", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const findings: ProofFinding[] = [{ id: "ae.meta", severity: "warning", message: "Missing description." }];
    const proof = await doctorProof(root, { level: "L2", findings });

    const extra = fakeDoctor(scratch, {
      version: 1,
      diagnostics: [
        { id: "ae.meta", severity: "warning", message: "Missing description." },
        { id: "ae.links", severity: "error", message: "No page at /missing/." },
      ],
    });
    const result = await verifyProof({ proof, siteRoot: root, doctor: true, doctorCommand: extra });
    assert.equal(result.ok, false);
    assert.equal(result.doctor, "mismatched");
    assert.deepEqual(result.failure, {
      kind: "doctor",
      recorded: 1,
      actual: 2,
      difference: 'the doctor reports "ae.links", which the proof does not record',
    });
    assert.match(verifyProofMessage(result), /doctor findings do not match/);

    const changed = fakeDoctor(scratch, {
      version: 1,
      diagnostics: [{ id: "ae.meta", severity: "error", message: "Missing description." }],
    });
    const severity = await verifyProof({ proof, siteRoot: root, doctor: true, doctorCommand: changed });
    assert.equal(severity.doctor, "mismatched");
    assert.match(verifyProofMessage(severity), /"ae.meta"/);

    const json = JSON.parse(formatVerifyProofJson(result, 1)) as VerifyProofReport;
    assert.equal(json.status, "failed");
    assert.deepEqual(
      json.diagnostics.map((diagnostic) => diagnostic.code),
      ["verify.doctor.mismatch"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a legacy level-only record and a doctor without recorded evidence are both unsupported, and exit 2", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const legacy = await doctorProof(root, { level: "L2" });
    const legacyResult = await verifyProof({
      proof: legacy,
      siteRoot: root,
      doctor: true,
      // Even a doctor that would report this level must not turn the record into a match.
      doctorCommand: fakeDoctor(scratch, { level: "L2" }),
    });
    assert.equal(legacyResult.ok, false);
    assert.equal(legacyResult.doctor, "unsupported");
    assert.equal(legacyResult.failure?.kind, "doctor-unavailable");
    const legacyJson = JSON.parse(formatVerifyProofJson(legacyResult, 2)) as VerifyProofReport;
    assert.equal(legacyJson.status, "invalid");
    assert.equal(legacyJson.diagnostics[0]?.code, "verify.doctor.unsupported");

    const none = await doctorProof(root);
    const { logs, io } = capture();
    assert.equal(await main(["edit", "verify", none, "--site", root, "--doctor", "--format", "json"], io), 2);
    const noneJson = report(logs);
    assert.equal(noneJson.doctor, "unsupported");
    assert.equal(noneJson.diagnostics[0]?.code, "verify.doctor.unsupported");
    assert.notEqual(noneJson.doctor, "matched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a legacy level-only doctor report is unavailable, not matched", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  const scratch = mkdtempSync(join(tmpdir(), "edit-verify-doctor-"));
  try {
    const proof = await doctorProof(root, {
      level: "L2",
      findings: [{ id: "ae.meta", severity: "warning", message: "Missing description." }],
    });
    const result = await verifyProof({
      proof,
      siteRoot: root,
      doctor: true,
      doctorCommand: fakeDoctor(scratch, { level: "L2" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.doctor, "unavailable");
    assert.equal(result.failure?.kind, "doctor-unavailable");
    const out = JSON.parse(formatVerifyProofJson(result, 2)) as VerifyProofReport;
    assert.equal(out.diagnostics[0]?.code, "verify.doctor.unavailable");
    assert.match(out.diagnostics[0]?.message ?? "", /not the version 1 diagnostics report/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a doctor that cannot run is unavailable, not a matching proof", async () => {
  const root = tree({ "docs/a.md": "after\n" });
  try {
    const proof = await doctorProof(root, {
      level: "L2",
      findings: [{ id: "ae.meta", severity: "warning", message: "Missing description." }],
    });
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
