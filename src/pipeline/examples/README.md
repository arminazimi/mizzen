# Examples

Units that run a site's recorded code examples and report whether they passed. A runner executes the fences; a
diagnostic turns a failed run into a finding. The engine runs them while it builds so a page can say its examples
were tested.

This folder is not a registry: nothing lists its files, so a unit is added or deleted on its own and no shared index
changes.

| Unit | What it does |
| --- | --- |
| `run-node.ts` | Runs one `js`, `mjs`, or `ts` snippet in a child process and returns `{ ok, exitCode, stdout, stderr, durationMs, timedOut }`. |
| `cache.ts` | Keeps each runner result under a content hash of the code, language, kind, and runtime, so an unchanged example is not run again. |
| `diagnostic.ts` | Builds the `example-failed` finding, with the fence's source span and a bounded expected-vs-actual window. |

## `run-node.ts`

`runNodeExample({ code, lang, timeoutMs?, env?, cwd? })` writes the snippet into a new `mkdtemp` folder — with a
`package.json` marking `js`/`mjs` as ES modules, and with `ts` relying on Node's native type stripping — and spawns
`process.execPath` there. `HOME` and `TMPDIR` point inside the same folder; the environment is otherwise only `PATH`,
`LANG=C.UTF-8`, and `NO_COLOR=1`, plus whatever the caller passes in `env`. Output is captured up to 64 KiB per
stream. When `timeoutMs` expires (10 seconds by default) the whole process group is killed with `SIGKILL`. The temp
folder is removed before the function returns, in every outcome. A failing, noisy, or hanging example is a result;
the function throws only for a caller's mistake (an unknown `lang` or a non-positive `timeoutMs`).

The runner is a **process sandbox, not an OS sandbox**. The example runs as the engine's user with the engine's file
permissions, so an absolute path, the network, or a process that leaves the group is still reachable. It promises a
clean start, a bounded run, and cleanup — not isolation from the host.

## `cache.ts`

`exampleCache({ dir?, root?, runtime? })` opens a result cache. The folder is `dir` when given, otherwise
`<root>/.mizzen/examples` (with the working directory as the default root). It is created on the first write, is safe
to delete, and needs no config key.

`cachedRun(cache, { code, lang, kind }, runner)` looks up the key `exampleCacheKey` makes from the code, language,
kind, and runtime — by default Node's `process.version` and the engine's version — and runs the example only on a miss.
A hit reports `durationMs: 0`, because nothing ran. Changing any of those inputs misses the entry.

Each result is one JSON file named after its key. The entry is written to a temporary folder and renamed into place, so
a reader never sees half an entry and no temporary file is left behind. `durationMs` is removed before writing, so the
same result always has the same bytes. A missing, unreadable, or corrupt entry is a miss, never a throw: the cache is a
speed-up, and a build that cannot use it only runs cold.

## `diagnostic.ts`

`exampleFailed` builds the `example-failed` finding:

```ts
import { exampleFailed } from "./diagnostic.ts";

exampleFailed({
  pos: { file: "guide/install.md", line: 42, column: 1, endLine: 42, endColumn: 3 },
  page: "/guide/install/",
  expected: "installed 3 packages\n",
  actual: "installed 2 packages\n",
});
```

- `pos` is the fence's source span, so `formatText` prints a code frame at the fence.
- `page` is the page's address, which names the page for a reader who only sees diagnostics.
- `expected` and `actual` are the example's wanted and observed output.
- `exitCode` is optional; when the runner knows it, the message names it.

The severity is **warning**. A failing example means the documentation has gone stale, not that the site is broken,
so the finding is reported and carried by the trust model without failing every build.

`firstDifference` is the small helper behind the message. It compares by Unicode code point and returns `offset` (the
code point where the two strings first differ, or the shorter length when one is a prefix of the other) plus a
bounded window of each side of at most 72 code points, starting up to 16 code points before the difference, with `…`
marking a cut. Newlines, tabs, backslashes, and control characters are escaped, so an example that prints several
lines or binary-ish text still yields one message line. The result depends only on its two arguments.

## Adding a unit

Add `run-<tool>.ts` beside this file that exports one function taking the snippet and options and returning the same
result shape, and add its tests in `packages/engine/test/run-<tool>.test.ts`. Units here do not register anywhere; the
output or page that uses them imports them directly.
