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
| cold build (no cache) | 4,710 | 300 | 0 |
| first cached build | 5,069 | 300 | 0 |
| no-op build | 139 | 0 | 0 |
| one body edit, incremental | 4,867 | 1 | 299 |
| same edit from scratch | 4,507 | 300 | 0 |

An unchanged build is the large win: 139 ms against ~4.7 s. A focused body edit re-renders one page but still pays for
the shared outputs that read every page — the search index, sitemap, feeds, twins, sourcemap, and the rest — so its
wall time stays close to a clean build at this size. The render cache narrows **work**, and the suite proves the
output is identical; this fixture does **not** show a wall-clock win for a single edit. Do not quote one.

The same command on `fixtures/docs-site` (594 pages) measured 10.3 s cold, 255 ms no-op, and 10.6 s for a one-page edit,
against 10.2 s for the same edit from scratch: the same shape, with shared outputs dominating. Both runs were taken on
the machine above with Node 24.22.2.

## Limits

- Rendering is skipped only when the settings digest and the page model are unchanged. A page that reads another page's
  body (through a theme component, not through front matter or `site.data`) is outside that contract; the digest covers
  titles, front matter, navigation, and data, which is what the shipped theme reads.
- A site with `mizzen.config.ts` plugins or outputs that read arbitrary files always builds cold, because what those
  files import cannot be keyed.
- The render cache stores one settings generation. Changing the theme, data, or a title retires it; the next successful
  build prunes the old generation.
- Timing numbers are per machine. There is no asserted performance budget for incremental builds: the checked-in
  budget covers shipped bytes (`docs/performance.md` in Lateen) and the deterministic output identity, not wall time.
