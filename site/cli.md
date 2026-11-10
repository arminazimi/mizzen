---
title: "CLI"
description: "CLI: Mizzen reference."
---

The package installs one command, `mizzen`, from `bin/slipway.ts`. Its help is the source of truth for the flags:

```text
Usage: mizzen <command> [dir] [options]

Commands:
  build [dir]               Build the site into --out (default: dist)
  check [dir]               Build to a temp folder and print diagnostics only
  dev [dir]                 Serve the site, rebuild on change, and reload the browser
  edit apply <patch.json> [dir]
                            Apply a span patch to its source file and record a proof
  edit verify <proof.json>  Check an edit proof against the site and rerun the doctor
  pack [dir]                Print one context pack for a topic, to stdout or --out
  verify [dir]              Check a built folder against the hash in its manifest
  watch [dir]               Rebuild the site whenever a source or theme file changes

Options:
  --out <path>         Output folder: build (default: dist), dev (default: .slipway/dev), watch (default: .slipway/watch); pack writes a file here instead of stdout
  --theme <dir>        Theme root folder (layouts/, chrome/, components/)
  --format <format>    text, json, or sarif (check only; default: text)
  --hash <hex>         Expected build hash for verify (default: the manifest's)
  --site <dir>         Site root for edit verify (default: .)
  --doctor             Rerun the doctor for edit verify
  --port <number>      Port for dev (default: 3000; 0 picks a free one)
  --host <host>        Host for dev (default: 127.0.0.1)
  --workers <n|auto>   Render pages in n worker threads; auto is the CPU count minus one (default: 1)
  --topic <name>       Topic for pack (default: the site's only topic)
  --budget <tokens>    Token budget for pack, overriding the topic's
  --dry-run            Print the diff for edit apply without writing
  --proof <path>       Proof record for edit apply (default: <patch>.proof.json)
  -h, --help           Show this help

Exit codes: 0 ok, 1 errors, 2 usage.
```

From this repository, run it as `node bin/slipway.ts`; from a site that installed the package, as `mizzen`.

| Command | What it does |
| --- | --- |
| `mizzen build [dir] --out <dir> --theme <dir>` | Builds `dir` (default `.`) into `--out` (default `dist`). Prints diagnostics as text. A build with an error still writes the site and exits `1`. |
| `mizzen check [dir] --format text\|json\|sarif --theme <dir>` | Builds into a temporary folder, prints only the diagnostics in the chosen format, and removes the folder. Exits `1` on an error. |
| `mizzen dev [dir] --port <number> --host <host> --theme <dir>` | Builds `dir`, serves the output with pretty URLs, watches the source and theme, rebuilds on change, and reloads the browser over Server-Sent Events. The reload script is added to HTML responses only; the files on disk stay as `build` wrote them. Ctrl-C stops the server. |
| `mizzen edit apply <patch.json> [dir] --dry-run --proof <path>` | Applies one span patch (the JSON shape of `src/edits/patch.ts`) to the source file its `span.file` names, resolved against `dir` and refused outside it. The patch is applied in memory and the file is replaced through a rename only when it succeeds, so a refused patch leaves it byte-identical. Writes an edit proof (`src/edits/proof.ts`) with the SHA-256 before and after, at `--proof` or `<patch>.proof.json`, and prints its path. `--dry-run` prints a unified diff and writes neither. Exits `1` on a refused patch or path, `2` on a missing or invalid patch. |
| `mizzen edit verify <proof.json> --site <dir> --doctor` | Re-hashes every file the edit's proof record names, under `--site` (default `.`), and compares each with its after-edit hash. The first mismatch is named, and the command exits `1`; a proof that cannot be read exits `2`. With `--doctor` it also runs `slipway doctor --format json` and compares the level with the recorded one; without it, the hashes are checked and the command says the doctor check did not run. |
| `mizzen pack [dir] --topic <name> --budget <tokens> --out <file>` | Prints the context pack for one topic in `_data/context-packs.yml` to stdout, or writes it to `--out`. `--budget` overrides the topic's budget; without `--topic` the site's only topic is used, and a site with several lists them and exits `2`. Diagnostics go to stderr, so stdout stays clean Markdown. |
| `mizzen verify [dir] --hash <hex>` | Hashes a built folder by the same rule the build used and compares it with `.slipway/manifest.json` (or `--hash`). Exits `1` on a mismatch. |
| `mizzen watch [dir] --out <dir> --theme <dir>` | Builds `dir` once, then rebuilds whenever a source or theme file changes. Changes are debounced and builds run one at a time, in order; an unchanged build is restored from `.slipway/cache`. Ctrl-C stops the watcher. |

`--out` is resolved from the current working directory, not from the site root, for `build`, `dev`, `pack`, and `watch`; `dev`'s default is `<site>/.slipway/dev` and `watch`'s is `<site>/.slipway/watch`. `check` is the command to use in CI: it never touches `dist`. `pack` reads the site model and never the theme, so it needs no theme root.

`--workers <n|auto>` (for `build` and `check`) renders pages in `n` worker threads, each one loading the theme; `auto` is the CPU count minus one. The site written is byte for byte the one `--workers 1` writes, diagnostics included. The default is `1`: a small site would pay for threads it cannot use, so a large one opts in with `--workers auto`. A worker that fails renders its pages in the main thread and adds a `render.worker-failed` warning. There is no config key, because how many cores a machine has is a machine setting, not a property of the site.

The theme root is picked in this order:

1. `--theme <dir>`, resolved from the current working directory.
2. `theme.name` in `mizzen.yml`: a folder relative to the site root, an absolute path, or a package name resolved from the site and then from the current directory.
3. The `theme` folder beside this package, when it exists.

A page with no layout in its front matter or in `defaults` gets the layout `doc` from the CLI. A programmatic build has no default unless it passes `defaultLayout`.
