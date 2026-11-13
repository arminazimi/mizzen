# Build performance and incremental work

This page records what an ordinary `mizzen build` reuses, how correctness is preserved, and the measured cost on a
fixed fixture. It is a baseline, not a target: the numbers come from one machine and Node version, and a change is
judged by comparing the same command on the same machine.

## What a build reuses

Three caches sit behind `mizzen build` (and `mizzen watch`, which passes `cache: true`):

1. **The whole-build cache** restores the finished output folder when every input is unchanged: the config file and
   its resolved values, every discovered source file, every include a page names, the navigation file, every theme and
   output file, the default layout, the engine version, and the Node/ICU version. A hit is verified file by file
   against the manifest before it is restored.
2. **The page cache** keys each page's Markdown parse by its expanded body, body line, plugins, and engine version, so a
   build that misses the whole-build entry parses only the pages whose content (or an include they use) changed.
3. **The render cache** keys each page's rendered layout HTML by the page model plus a settings digest that covers the
   config, navigation, data, theme, outputs, every page's front matter, the layout, and the engine/runtime. A body-only
   edit therefore re-renders that page and reuses the rest; a title, nav, data, theme, or output change retires every
   page render, because any page can show another page's title.

The dependency graph and invalidation plan turn the pages whose render key missed into the affected outputs, with the
shortest causal chain to each changed input. For example, editing `_snippets/note.md` names the pages that include it,
not the pages that merely sit next to them. The plan is exposed on the build result; `mizzen watch` rebuilds through
the same path.

A cache miss, a corrupt or foreign-format entry, a site with a code file, or an unreadable render is a **miss**: the
build renders the page or builds cold. Nothing is guessed from an incomplete entry. `mizzen build` never needs the
cache to be correct; deleting `.mizzen/cache` costs time, not output.

## Same-build evidence

Before any page renders, the build computes the drift findings and trust entries for its own pages and puts them in
`site.data.drift` and `site.data.trust`, so a theme can show current evidence without a second build or a hand-written
data file. Outputs still run on the raw site: `trust.json` and `drift.json` write their own reports with their own
provenance.

Review lookups are batched: one `git rev-parse` and one `git log --name-only` answer every page in a build, instead of
one git process per page. On `fixtures/docs-site` (594 pages) the trust pass went from 7.7 s to about 0.2 s, and drift
from 0.16 s to 0.16 s. That is where the baseline below improved by roughly 3x: the old numbers were dominated by
process spawns, not by the engine.

The render cache key carries each page's own evidence, not a site-wide digest, so a body edit still retires one page.
A commit changes the repository state and the evidence, which is part of the whole-build key, so no page can render
with the previous HEAD's review date.

## Correctness

The suite proves the two properties that make the caches safe:

- `test/cache.test.ts` — an unchanged build restores identical bytes, and corrupt, foreign-format, or missing entries
  fall back to a build instead of bad output.
- `test/page-cache.test.ts` — a second build parses no pages, changing one page parses only that page, and changing an
  include re-parses only its includers.
- `test/incremental-build.test.ts` — after a body edit, a snippet edit, or a title change, the incremental output is
  compared with a clean build of the same source **byte for byte**; the test also asserts which pages rendered and
  that the invalidation plan names exactly the affected outputs. A corrupt render entry is a miss.

## Measured baseline

Command (generates its fixture in a temporary folder, prints the table, writes nothing into the repository):

```bash
node scripts/bench-incremental.ts --pages 300
```

The generated site has 300 doc pages, an explicit navigation file, and a shared snippet included by every tenth page.
The theme is the sibling Lateen checkout, the layout is `doc`.

Machine and runtime recorded with the numbers:

| Item | Value |
| --- | --- |
| CPU | Apple M5 |
| OS | macOS 27.2.1 (darwin/arm64) |
| Node | 24.22.2 |
| Theme | `../lateen` at the release candidate |
| Pages | 300 |

Result (milliseconds, one run; the script prints the pages rendered and reused):

| Phase | Wall time | Rendered | Reused |
| --- | --- | --- | --- |
| cold build (no cache) | 1,067 | 300 | 0 |
| first cached build | 1,449 | 300 | 0 |
| no-op build | 140 | 0 | 0 |
| one body edit, incremental | 1,159 | 1 | 299 |
| same edit from scratch | 781 | 300 | 0 |

An unchanged build is the large win: 140 ms against ~1.1 s. A focused body edit re-renders one page but still pays for
the shared outputs that read every page — the search index, sitemap, feeds, twins, sourcemap, and the rest — so its
wall time stays close to a clean build at this size. The render cache narrows **work**, and the suite proves the
output is identical; this fixture does **not** show a wall-clock win for a single edit. Do not quote one.

The same command on `fixtures/docs-site` (594 pages) measured 3.3 s cold, 155 ms no-op, and 3.4 s for a one-page edit,
against 2.8 s for the same edit from scratch: the same shape, with shared outputs dominating, and single-run ordering
noise at this size. The earlier 10.3 s cold figure was almost entirely the per-page git spawns described above. All
runs used the machine above with Node 24.22.2.

## Limits

- Rendering is skipped only when the settings digest, the page model, and the page's own evidence are unchanged. A page
  that reads another page's body (through a theme component, not through front matter or `site.data`) is outside that
  contract; so is a theme that aggregates evidence across pages instead of reading its own entry, which the shipped
  panel and banner do not do.
- A site with `mizzen.config.ts` plugins or outputs that read arbitrary files always builds cold, because what those
  files import cannot be keyed.
- The render cache stores one settings generation. Changing the theme, data, or a title retires it; the next successful
  build prunes the old generation.
- Timing numbers are per machine. There is no asserted performance budget for incremental builds: the checked-in
  budget covers shipped bytes (`docs/performance.md` in Lateen) and the deterministic output identity, not wall time.
