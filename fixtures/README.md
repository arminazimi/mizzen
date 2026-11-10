# Fixtures

Shared inputs for tests, benchmarks, and screenshots. Every epic builds against the same two sites, so a number measured in one task means the same thing in another.

| Folder | What it is |
| --- | --- |
| `docs-site/` | An Evergreen-shaped docs site of about 600 pages: the hand-written Beacon pages, 30 reference pages, 550 generated rule pages under `rules/`, an app page (`dashboard/`) with its own HTML, CSS, and JavaScript, a site-owned `llms.txt`, and `features.md`, which uses every Markdown construct the components support. Some pages have no front matter and start with an `h1`. |
| `rtl-site/` | Five Persian pages, right to left, mixing Persian and English, code blocks, and numbers. |

## Rules

- **Fixtures are read-only.** A task does not edit a fixture file to suit itself, because every other task reads the same file. A task that needs new content adds a new fixture folder next to these and says why in its pull request.
- **Generated output is committed.** `node fixtures/docs-site/generate.ts` rewrites `docs-site/rules/` deterministically (a fixed seed, no clock), so running it twice gives no diff. `--check` fails when the folder is stale.
- **Each site has its own `mizzen.yml`** and builds on its own: `mizzen build fixtures/docs-site`.
