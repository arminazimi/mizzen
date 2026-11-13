---
name: mizzen
description: Develop, debug, test, and review the Mizzen repository (@velella/mizzen), including its deterministic documentation pipeline, contracts, CLI, source maps, outputs, plugins, and editing tools. Use whenever a task touches the mizzen checkout or changes docs-engine behavior, even if the user only says "docs engine" or names a file under src, bin, schema, fixtures, or test. Do not use for Lateen-only layouts, styling, tokens, or components, or for dependency lifecycle checks.
license: Apache-2.0
metadata:
  author: Velella
  version: "1"
---

# Mizzen engine workflows

Work from the repository root. Read `README.md`, `CONTRIBUTING.md`, and the README nearest the unit being changed. Keep the sibling `../lateen` checkout installed for the full suite. Read the relevant contract, callers, implementation, and nearby tests before editing.

Preserve the engine's boundaries and guarantees:

- **Theme-free.** Shipped code under `src/` and `bin/` never imports Lateen or reaches outside the package. The CLI's sibling-theme fallback is not an engine dependency; `test/boundary.test.ts` checks this.
- **Layered.** Config, discovery, front matter, Markdown, HTML, site model, render, and outputs communicate through `src/contracts/`. Do not bypass a stage or change a frozen contract casually.
- **Deterministic.** Identical input produces byte-identical files in identical order with LF endings. Keep clocks, randomness, environment-dependent values, unstable traversal, and unsorted output out of build behavior.
- **Traceable.** Preserve exact source positions in parsing, Markdown, source maps, edits, and diagnostics.
- **Diagnostic.** Expected content, configuration, and theme problems become useful diagnostics with paths and spans. A throw represents a bug, not an ordinary user error.
- **Safe.** Output paths stay inside the output root, collisions follow established rules, and failures do not partially replace the previous output.

Use erasable TypeScript that Node 24 runs directly: `.ts` extensions in relative imports, `import type` for types, and no `enum`, `namespace`, parameter properties, or compiled output in commits. Prefer existing contracts and Node built-ins.

## Route the task

| Task | Workflow |
| --- | --- |
| Pipeline, model, cache, or workers | Inspect `src/pipeline/`, `src/model/`, related contracts, and tests; verify repeated-build determinism |
| Configuration | Change `src/config/`, `src/contracts/config.ts`, and `schema/config.schema.json` together |
| Markdown or source positions | Inspect `src/markdown/`, `src/content/`, `src/source/`, and span tests |
| Rendering or theme loading | Inspect `src/render/` and `src/contracts/render.ts`; do not add theme code |
| CLI | Inspect `src/cli/`, `bin/mizzen.ts`, help text, exit codes, and CLI tests |
| Span edits or proofs | Inspect `src/edits/`; exercise `edit apply --dry-run` before a real apply |
| Generated artifact | Follow the output workflow below |
| Derived site value | Follow the fact workflow below |

Run the CLI from a checkout as `node bin/mizzen.ts`. Its implementation and `node bin/mizzen.ts --help` are the source of truth for flags and exit codes.

## Add an output

1. Read `src/outputs/README.md` and `src/contracts/output.ts`.
2. Add one file under `src/outputs/`; discovery needs no shared-index edit. The exported `name` must match the filename.
3. Return files sorted by path, using `/` separators and deterministic contents. Report content problems through `ctx.report()` instead of throwing.
4. Preserve path containment, collision precedence, and site-file ownership. Add tests for the artifact and relevant failures.

## Add a fact

1. Read `src/model/facts/README.md` and `src/model/facts.ts`.
2. Add one file under `src/model/facts/` with a matching `name`; no shared-index edit is needed.
3. Keep `compute()` deterministic. Facts cannot read one another's derived values, and a site's `_data` value wins.
4. Test the value, precedence, and relevant diagnostics.

## Verify

Add or update `test/*.test.ts` for behavior changes. Run a focused test during development, then:

```bash
npm run typecheck
npm test
```

For docs-site changes, run `node bin/mizzen.ts check site` and require zero errors. For package exports or packed-file changes, also run `npm run build` and `scripts/smoke-package.sh ../mizzen ../lateen`; do not commit generated artifacts. Report exactly which checks ran and any environmental limitation.
