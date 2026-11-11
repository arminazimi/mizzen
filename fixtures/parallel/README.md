# Parallel fixture

A 24-page site and a theme whose `doc` layout holds its thread for 25 ms and records the interval it held for. The
parallel tests read those records to see how many pages rendered at the same time, so the pool's bound and its
cancellation are checked by what actually ran, not by what the pool says it did.

- `site/` is the content: 24 pages under `guide/`, all using the `doc` layout.
- `theme/` is the theme: one layout, `layouts/doc.ts`, which is identical in a worker and in this process.
- Recording is off unless `MIZZEN_PARALLEL_TRACE` names a folder. Each render then writes one
  `<pid>-<threadId>-<n>.json` file there with its URL and the `hrtime` interval it held for; a test removes the folder
  when it is done.

The fixture is read-only: the tests point the trace at a temporary folder and never write here.
