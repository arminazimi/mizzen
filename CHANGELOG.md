# Changelog: @velella/mizzen

Releases of this package are tagged `v<version>`. Add a one-line fragment in `changelog.d/` in any pull request a user would notice; the release tool moves fragments here.

## Unreleased

## 0.2.0 — 2026-11-13

This release makes the engine's claims checkable: the CLI reports what it actually does, an agent edit is
committed with its proof and audit record or not at all, trust and drift come from the build that wrote
the page, incremental work reuses only inputs it can prove unchanged, and a task pack explains every
selection, omission, and token it spent.

### Added

- **`mizzen doctor`** checks the config, content, output paths, runtime, and toolchain, and reports each
  check independently, including SARIF output and `--format json`.
- **`mizzen pack --request`** compiles a versioned task request from a file or stdin: task kind and
  intent, include/exclude/locale/version constraints, required references, and a hard token budget.
  Packs publish selection, omissions, source positions, trust evidence, and token accounting.
- **Machine-readable edit results** for `edit apply` and `edit verify` (`--format json`), including
  refusals, the failed check, and the paths a proof covers.
- **An edit provenance ledger** (`<patch>.audit.jsonl`) and an atomic source + proof + audit commit, so
  a failed step never produces a successful provenance record.
- **Same-build trust and drift evidence** in `site.data` for every page, with explainable levels,
  reviewer coverage, signal provenance, exact source spans, and explicit unknown/unavailable states.
- **Incremental builds** keyed by config, content, navigation, theme, outputs, and engine version, with a
  per-page Markdown cache, a dependency graph, a deterministic invalidation plan, and bounded worker
  scheduling. A cache miss, corrupt entry, or site code file falls back to a full build.
- **`mizzen watch`** coalesces bursts losslessly, survives watcher failures, and follows renames and
  atomic saves.

### Changed

- CLI help, the README, and generated `AGENTS.md` guidance list only commands that exist.
- A packed install no longer inherits a `lateen` checkout beside the source tree.
- Example execution is isolated with resource limits, and skipped or unrun examples no longer count as
  passing evidence.
- Cache writes and audit appends are concurrency-safe; abandoned locks are reclaimed only when their
  owner is gone.

### Fixed

- Includes, theme assets, edit writes, and proof paths are confined through real paths, including
  symbolic links.
- Malformed trust counts, review evidence, drift severities, version bounds, token estimates, and
  diagnostic fields are reported instead of clamped or silently accepted.
- Git-history evidence, proof verification, worker rendering, and pack input have explicit bounds.
- Version bounds are compared without numeric overflow, and pack budgets honour estimator margins.

### Compatibility

- The CLI commands and flags from 0.1.0 keep working. `--allow-unchecked` is required only for a patch
  that carries neither `expected` nor `beforeHash`.
- Generated JSON now carries the engine version `0.2.0`. Consumers that pinned the literal `0.1.0`
  string, including the old hard-coded engine check in the test suite, should read the exported
  `version` instead.
- The trust, drift, pack, and edit JSON documents gained fields; existing fields keep their names and
  meanings. A consumer that validates against the bundled schemas should update to the 0.2.0 schemas.

## 0.1.0

First release: the `mizzen` CLI and library, compiled to JavaScript with type declarations, plus the JSON schemas.

