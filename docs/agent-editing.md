# Agent editing: apply, prove, verify

Mizzen exposes two commands for an agent edit loop:

```sh
mizzen edit apply <patch.json> [dir] [--dry-run] [--proof <path>] [--allow-unchecked] [--format text|json]
mizzen edit verify <proof.json> [--site <dir>] [--doctor] [--format text|json]
```

`edit apply` replaces one exact source span, then commits the source, a proof record, and one
provenance line as a single transaction. `edit verify` re-checks a proof against the working tree.
Everything below is the behavior implemented in `src/cli/edit-apply.ts`, `src/cli/edit-verify.ts`,
`src/edits/transaction.ts`, `src/edits/proof.ts`, `src/edits/proof-verifier.ts`, `src/edits/patch.ts`,
`src/edits/audit.ts`, and `src/edits/plan.ts`; the public-CLI coverage is
`test/edit-loop.test.ts`.

```sh
# the two commands this document describes, against a temp fixture created by the test file
node --test test/edit-loop.test.ts
npm run typecheck
```

## Patch document

A patch is plain JSON: one span, optionally the text and whole-file hash it was computed from, and
its replacement.

```json
{
  "span": {
    "file": "docs/a.md",
    "line": 1,
    "column": 1,
    "endLine": 1,
    "endColumn": 5
  },
  "expected": "# Old",
  "replacement": "# New",
  "beforeHash": "5f2b…64 lowercase hex characters…"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `span.file` | yes | Source path relative to the site root. Resolved with `resolve(root, file)`, then confined lexically and by real path (see [Safety boundaries](#safety-boundaries)). |
| `span.line`, `span.column` | yes | 1-based start. Columns count Unicode code points, so an astral character is one column. |
| `span.endLine`, `span.endColumn` | yes | 1-based inclusive end. The end names a real character, not the position after it. |
| `expected` | no | Exact text the span held when the patch was planned. Compared byte-for-byte, line endings included. |
| `replacement` | yes | Text that takes the span's place. `""` deletes the span. |
| `beforeHash` | no | SHA-256 of the whole source file the patch was computed from. Any hex case is accepted; comparison lowercases it. |

Unknown keys are ignored. A patch that is missing a required field, is not JSON, or contains a
non-positive/non-integer line or column is a usage error (exit 2). A patch whose `beforeHash` is a
string but is not the file's SHA-256 is a refused patch (exit 1), not a usage error.

### Planning before applying

There is no `edit plan` CLI command. Planning is the library function `planHeadingEdit` in
`src/edits/plan.ts`, called against a site model; it returns exactly the patch object above
(`span`, `expected`, `replacement`, `beforeHash`). The CLI accepts only the written patch document.
`test/edit-loop.test.ts` plans a heading edit with `buildModel` + `planHeadingEdit`, writes the
patch, and applies it through `main()`.

### Preconditions are all-or-nothing

If a patch carries `expected` or `beforeHash`, it must carry both; the CLI requires both whenever
either is present, including under `--allow-unchecked`. A patch carrying only one is refused
(exit 1) with "has no beforeHash" / "has no expected text", and nothing is written. This prevents a
minimized patch from silently dropping its staleness check.

A patch carrying neither precondition cannot rule out a stale source. `edit apply` refuses it with
exit 2 and names `--allow-unchecked`; only that flag authorizes the edit. The flag cannot
half-authorize a patch that carries one precondition.

`--dry-run` still checks every precondition the patch carries, prints a unified diff, and writes
nothing (no proof, no ledger). An unchecked patch still needs `--allow-unchecked` even for a dry
run.

## Proof document

`edit apply` writes this record at `--proof <path>`, or by default at
`"<resolved patch path>.proof.json"`:

```json
{
  "version": 1,
  "files": [
    {
      "path": "docs/a.md",
      "before": "SHA-256 of the source before the patch",
      "after": "SHA-256 of the source after the patch"
    }
  ]
}
```

`before` is `null` only when the file did not exist before the edit. `date` is added when
`SOURCE_DATE_EPOCH` is set; otherwise the record has no timestamp and no wall clock is read.
`edit apply` writes exactly one file entry and never writes `spans`, `doctor`, or `examples`.

The wider proof format (`src/edits/proof.ts`, used by `writeProof` outside this CLI path) supports:

- `files[].spans`: resulting spans with a SHA-256 of the text each covers;
- `doctor`: `{ "level": "L0"|"L1"|"L2"|"L3"|null, "findings": [...] }`;
- `examples`: `{ "rerun": [...], "passed": n, "failed": n, "skipped"?: n }`;
- `date`: ISO 8601 UTC.

Because `edit apply` never records spans or doctor evidence, those capabilities are not part of
the CLI loop today (see [Limitations](#remaining-limitations)).

## Audit ledger record

Every applied patch also appends one line to `"<resolved patch path>.audit.jsonl"` — there is no
flag to move it. One compact JSON object per line, keys in this order, one trailing line feed:

```json
{"version":1,"id":"<sha256>","outcome":"applied","plan":{"file":"docs/a.md","span":{"line":1,"column":1,"endLine":1,"endColumn":5},"beforeHash":"…","afterHash":"…"},"verification":{"status":"skipped","checks":[]}}
```

- `id` is SHA-256 over `{version, outcome, plan{file, span, beforeHash, afterHash}}`, so the same
  plan correlates without a clock.
- `edit apply` always writes `verification: { "status": "skipped", "checks": [] }`. It does not run
  verification.
- `date` appears only with `SOURCE_DATE_EPOCH`.
- The line is appended by rewriting the ledger and renaming it into place as part of the same
  transaction as the source and proof. Existing bytes are preserved byte-for-byte; a ledger that
  does not end with a line feed is refused, never repaired. If the identical line is already
  present, no new line is appended.
- Free text that the ledger does keep (verification checks written by other callers) is redacted
  for credentials and absolute machine paths by `src/edits/audit.ts`.

## Commands and exit codes

### `edit apply`

```sh
mizzen edit apply patch.json                  # site root "."
mizzen edit apply patch.json site/            # site root site/
mizzen edit apply patch.json site/ --dry-run
mizzen edit apply patch.json site/ --proof records/edit.json
mizzen edit apply patch.json site/ --format json
```

- `0` — the patch was applied, or a dry run would apply it.
- `1` — refused: stale `expected`/`beforeHash`, span outside the source, source missing, path
  outside the site root (including an escaping symlink), or a write/transaction failure. The
  artifacts are unchanged unless the message says the rollback itself was incomplete.
- `2` — usage: patch missing or unreadable, patch not JSON, malformed span/replacement, a patch
  with neither precondition and no `--allow-unchecked`, or invalid CLI options.

Success in text mode writes the source file and prints:

```
mizzen edit apply: wrote docs/a.md
mizzen edit apply: proof /abs/path/patch.json.proof.json
```

A dry run prints the unified diff, then `mizzen edit apply: dry run: docs/a.md would change;
nothing was written`.

### `edit verify`

```sh
mizzen edit verify patch.json.proof.json
mizzen edit verify patch.json.proof.json --site site/
mizzen edit verify patch.json.proof.json --site site/ --doctor
mizzen edit verify patch.json.proof.json --site site/ --format json
```

- `0` — every recorded file matches its `after` hash (and every recorded span, when the proof has
  spans). Without `--doctor` the doctor is reported as not run.
- `1` — a recorded file changed, is missing, is unexpectedly present, a span moved/hashes
  differently/is out of range, a recorded path resolves outside the site root, or the doctor's
  findings differ from the proof's.
- `2` — the proof cannot be read or is malformed/wrong version, or the doctor check cannot run or
  has no evidence to compare (`--doctor` on a proof with no findings).

Text mode prints `mizzen: ` plus one sentence per failed claim on stderr, or one `ok: …` line on
stdout. Every file is checked; all mismatches are reported in path order.

`--format json` prints one document on stdout in both modes, with `version`, `command`,
`status` (`ok` / `failed` / `invalid`), `ok`, `exitCode`, `proof`, `siteRoot`, `files`, `doctor`,
and `diagnostics`. A failure has `ok: false` and `status` `failed` or `invalid`; it never reports a
success status. Apply's JSON report similarly carries `status`, `ok`, `exitCode`, `applied`,
`file`, `proof`, `beforeHash`, `afterHash`, `diff`, and `diagnostics`.

## Atomic source + proof + audit commit

`edit apply` computes the entire new source in memory first, then builds the proof and ledger
bytes, then calls `commitArtifacts`:

1. Each target's current bytes and mode are read. A target that is a directory, a path listed
   twice (for example `--proof` pointing at the source), or a parent that cannot be a directory is
   refused.
2. New bytes are staged in a hidden `.edit-transaction-*` folder beside each target; an existing
   file's mode is preserved.
3. Immediately before any rename, every target with an `expectedBeforeHash` is re-read. If the
   source, ledger, or proof changed since it was read, the whole set is refused as stale input and
   nothing is renamed.
4. Files are renamed in order: **proof, ledger, source**. The source is last, so it is never
   replaced before the records describing it exist.
5. If a rename fails, artifacts already committed are restored in reverse from the pre-staged
   bytes (or removed when they did not exist). Staging folders are always removed. An incomplete
   rollback is reported in the error (`rollback incomplete: …; check the tree`) rather than
   reported as success.

Consequences: a refusal or handled failure leaves the source, proof, and ledger byte-identical;
the changes are all-or-nothing at the process level. The transaction is not a single filesystem
atomic operation and does not `fsync`: a crash or `SIGKILL` between renames can leave a partial
set, because rollback only runs for caught errors. The default proof path and the ledger path are
derived from the patch path, so keeping the patch beside the site keeps artifacts together.

## Stale edits, unchecked edits, and authorization

- A planner patch carries `expected` + `beforeHash`; either one mismatching refuses the edit
  (`edit.patch-refused`, exit 1) before any bytes are written. In the test, after a successful
  apply, replaying the original patch and replaying a patch with the wrong `expected` both leave
  the changed source, the proof, and the ledger byte-identical, and append nothing.
- A patch with neither precondition is unauthorized by default: exit 2, no source change, no
  proof, no ledger line. `--allow-unchecked` is the explicit authorization; it applies the span
  after the normal in-range/overlap checks.
- The patch file itself may live outside the site root; only `span.file` (and therefore the
  written source) is confined. `--proof` may also point outside the root.

## Verification

`edit verify` parses the proof (`version` must be `1`), sorts file entries by path, and for each:

1. resolves `realpath` and refuses a target whose real path is outside the site root
   (`verify.path.escape`, exit 1) without reading it;
2. reads the resolved path and compares the whole-file SHA-256 with `after` (`null` means the file
   must be absent; a present file is `verify.file.extra`, an absent one `verify.file.missing`);
3. checks recorded spans, when present: text moved (`verify.span.moved`), hash mismatch
   (`verify.span.hash`), or out-of-range (`verify.span.range`).

The doctor is optional and runs as a separate process, never an import: by default a sibling
`doctor/bin/mizzen.ts` through `node` when present, otherwise `mizzen` on `PATH`, invoked as
`doctor <siteRoot> --format json` with the site root as cwd. It accepts exit 0 or 1, parses
`{ "version": 1, "diagnostics": [...] }`, and compares the fields the proof recorded (id,
severity, message, file, line, column). A mismatch exits 1; a doctor that cannot run, exits on a
signal, or produces an unsupported/legacy report exits 2 and is never treated as a match.

Verification is read-only. It never rewrites the proof, never changes the source, and never appends
to the audit ledger. A failed verification therefore cannot produce a new successful provenance
line; the ledger still contains only the earlier `applied` record with verification `skipped`, and
the proof still describes the bytes that were committed, not the tampered tree.

`--doctor` on a proof written by `edit apply` always exits 2: the apply proof records no doctor
findings, so there is nothing to compare (`verify.doctor.unsupported`, "the proof records no doctor
evidence to compare").

## Safety boundaries

- **Root confinement.** `span.file` is resolved against the site root and checked twice: lexically
  (`relative(root, resolved)` must not be empty, `..`, or absolute) and by real path (`realpath`
  of the target must stay inside the real root). A lexical escape (`../outside.md`) and an
  in-root symlink whose real target leaves the root are both refused before the source is read.
  `edit verify` applies the same real-path confinement to every recorded path and reads only the
  resolved path.
- **Symlinks.** An in-root symlink is written through: the real target's bytes change, the link
  remains a link, and the target's mode is preserved. An escaping symlink is refused
  (exit 1, "resolves outside the site root"). A missing source is reported after the containment
  check, so a missing path cannot be used to probe outside the root.
- **Span bounds.** Lines and columns must be 1-based positive integers; the end must be on or
  after the start, inside the file, and inclusive. An out-of-range span is `out-of-range`
  (`edit.patch-refused`, exit 1). Whole-file hashes and proof span hashes are SHA-256 over UTF-8
  bytes/text.
- **Timeouts and caps.** Apply has no timeout and no explicit input-size cap: the patch JSON and
  source are read whole into memory. Verify's doctor run is bounded by 30 s
  (`DOCTOR_TIMEOUT_MS`), `SIGKILL`, and a 16 MiB stdout cap. The moved-span search in proofs with
  spans is bounded by 100,000 code points per span, 2,000,000 per file, 262,144 SHA-256
  confirmations, and 16,777,216 candidate code points; reaching a cap falls back to a hash
  mismatch rather than an unbounded scan.
- **Destinations.** The transaction refuses a directory target, a path listed more than once, and
  a non-directory parent. The ledger is appended only to a file ending in `\n`; a damaged ledger
  is refused without repair.

## Remaining limitations

These are real gaps in the current CLI, not promises:

1. **One patch, one span, one file per invocation.** There is no multi-file or multi-span atomic
   edit through `edit apply`; the patch document has no list of edits.
2. **Apply-written proofs have no span or doctor evidence.** `edit verify` can only re-hash the
   whole file for these proofs. It cannot confirm that the recorded span still covers the intended
   text, and `--doctor` can never pass on an apply proof (always exit 2, unsupported).
3. **Verification is not recorded.** `edit verify` appends nothing to the ledger. The ledger line
   written by `edit apply` permanently says `verification: {"status":"skipped","checks":[]}`, so
   there is no persisted provenance that a verification ran or what it found.
4. **Crash atomicity is not guaranteed.** The three renames are ordered but not one atomic
   operation, and there is no `fsync`. A process crash or power loss between renames can leave a
   new proof/ledger with an old source, or the reverse. Rollback handles thrown errors only.
5. **No lock on the apply ledger.** `edit apply` appends by rewriting the ledger inside the
   transaction; it does not use `appendEditAudit`'s `O_EXCL` lock. Concurrent applies are detected
   by the pre-rename hash re-read (one can fail as stale input), but there is no waiting lock and
   no lock diagnostic.
6. **No `edit plan` or ledger-inspection command.** Planning is a library API; there is no CLI to
   produce a patch from a heading, and no CLI to read or verify the audit ledger.
7. **No creation or deletion of whole files.** The proof format can express a file that was
   absent before or after the edit, but `edit apply` only rewrites the span of an existing source;
   it cannot create or delete a file.
8. **Patch shape is loosely validated.** Unknown keys are ignored, and a `beforeHash` that is a
   string but not 64 hex characters becomes a hash mismatch (exit 1) rather than a usage error.
9. **Artifact locations are caller-controlled.** The patch file and `--proof` may be outside the
   site root; the ledger is always beside the patch. Only the source path is confined.
10. **No authenticity.** Proofs and ledger lines are plain JSON with hashes; there is no signature
    or trust root, so they prove internal consistency, not who wrote them.
11. **Doctor is an external command.** Its contract is the diagnostics JSON only; a different
    version or shape exits 2, and a doctor that hangs is killed at the deadline rather than
    diagnosed further.

## What the tests cover

`test/edit-loop.test.ts` drives `main()` from `src/cli/index.ts` against temporary trees:

- a planned heading edit applied via `edit apply --format json`, with the proof file, the
  `<patch>.audit.jsonl` line, the changed source bytes, and `edit verify` in text and JSON modes;
- a stale patch (wrong hash and wrong `expected`) leaving source, proof, and ledger byte-identical
  and appending nothing, with a JSON refusal that is `failed`/`ok: false`;
- a changed covered file making `edit verify` exit 1, naming `verify.file.changed`, `check:
  "hash"`, and `docs/a.md`, never reporting `ok`, and leaving the ledger alone;
- an unwritable ledger destination during the transaction leaving source, proof, ledger, and the
  whole tree byte-identical (no staging residue), with a `failed`/`ok: false` JSON result;
- no successful provenance for unchecked, malformed, escaping, or verification-failed steps;
- `--allow-unchecked` authorization, root confinement (lexical and symlink), and malformed-patch
  usage errors, each through the CLI.

The module-level mid-commit rollback hooks and their byte-for-byte restore assertions live in
`test/cli-edit-transaction.test.ts`; the CLI cannot pass those hooks, so the loop test forces the
CLI-reachable pre-rename failure (an unwritable destination) instead.
