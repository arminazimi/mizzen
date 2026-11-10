<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/arminazimi/mizzen/main/.github/assets/mark-night.svg">
    <img src="https://raw.githubusercontent.com/arminazimi/mizzen/main/.github/assets/mark-day.svg" width="96" height="96" alt="Mizzen">
  </picture>
</p>

<h1 align="center">Mizzen</h1>

<p align="center">
  <strong>Same input. Same site.</strong><br>
  A deterministic docs engine with exact source positions.
</p>

<p align="center">
  <a href="https://github.com/arminazimi/mizzen/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/arminazimi/mizzen/ci.yml?branch=main&label=CI&logo=github&logoColor=white&labelColor=1F1F28&color=3F6E66&style=flat"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-3F6E66?labelColor=1F1F28&style=flat"></a>
  <a href="https://arminazimi.github.io/mizzen/"><img alt="docs" src="https://img.shields.io/badge/docs-mizzen-3F6E66?labelColor=1F1F28&style=flat"></a>
</p>

<p align="center">
  <a href="https://arminazimi.github.io/mizzen/install/">Quick start</a> ·
  <a href="https://arminazimi.github.io/mizzen/">Documentation</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="https://github.com/arminazimi/lateen">Lateen</a>
</p>

---

A deterministic docs engine with exact source positions: config, the content model, Markdown, navigation, the render host, outputs, diagnostics, and the CLI. It knows nothing about the theme: nothing here imports from the theme, and no theme name, color, or layout appears in it. `test/boundary.test.ts` is the place to enforce it.

## Why Mizzen

- **Deterministic.** The same input gives byte-identical output, in the same order, with LF line endings.
- **Traceable.** Every page keeps the exact source position of its text, so a tool or an agent can edit the right line.
- **Agent-ready.** A build also writes `llms.txt`, Markdown twins, a source map, and per-page JSON beside the HTML.
- **Theme-free.** The engine knows nothing about colors or layouts; [Lateen](https://github.com/arminazimi/lateen) draws the pages.

A build runs eight stages, each a function from typed input to typed output: config, discover, front matter, Markdown, HTML, site model, render, and outputs. Stages talk only through the frozen types in `src/contracts/`. The same input gives byte-identical output, in the same order, with LF line endings.

## No build step

The source is TypeScript that Node runs directly through type stripping (Node 24 or later). Use only erasable syntax (no `enum`, `namespace`, or parameter properties), import local files with their `.ts` extension, and mark type-only imports with `import type`. `tsconfig.json` enforces this and emits nothing; never commit compiled output.

## Commands

- `npm test` runs `node --test` on `test/**/*.test.ts`.
- `npm run typecheck` runs `tsc --noEmit`.

Many tests build the fixtures in `fixtures/` with the theme, so check out [Lateen](https://github.com/arminazimi/lateen) next to this repository (`../lateen`) and run `npm ci` in both.

## CLI

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

## Config

A site's settings live in `mizzen.yml` at its root; every path in the file is relative to that folder. Without the file the engine builds with the defaults below and the folder name as the title. The top level is closed: an unknown key is an error with its line and column. The schema is [`schema/config.schema.json`](schema/config.schema.json), and `SiteConfig` in `src/contracts/config.ts` is the same shape.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string | the folder name | Site name in the header, page titles, `llms.txt`, and JSON-LD. |
| `description` | string | | One-sentence summary for the home page's meta description and `llms.txt`. |
| `url` | string | | Scheme and host of the published site, without a trailing slash, such as `https://example.com`. Needed for canonical links, social images, and an absolute sitemap; without it they are relative or left out, with a warning. |
| `base` | string | `""` | Path the site lives under, starting with `/` and without a trailing slash; empty at a domain root. Every URL the engine writes carries it. |
| `lang` | string | `en` | Default language of every page, as a BCP 47 tag. A page's `lang` wins. |
| `dir` | `ltr` or `rtl` | from `lang` | Default text direction: `rtl` for `fa`, `ar`, `he`, `ur`, and the other right-to-left languages. A page's `dir` wins. |
| `languages` | list of `{code, name, prefix}` | `[]` | The site's languages, in switcher order. Leave it out for a one-language site. |
| `source` | string | `.` | Folder that holds the content, relative to the site root. Files outside it are not pages. |
| `include` | list of strings | `[]` | Paths under `source` that discovery would skip (names starting with `.` or `_`) but should copy or build, such as `.well-known`. |
| `exclude` | list of strings | `[]` | Paths under `source` that are neither pages nor copied. `node_modules`, the output folder, and `mizzen.yml` are always excluded. |
| `navigation` | string | `_data/navigation.yml` | Navigation file, relative to the site root. Without it, navigation is built from folders and each page's `order`. |
| `defaults` | list of `{path, values}` | `[]` | Front matter applied to every page under a path unless the page sets the key itself. Later entries win over earlier ones; a page always wins. |
| `repository` | `{url, branch, dir}` | | Where the source lives, for "Edit this page" links and the "Edit with your agent" prompt. `branch` defaults to `main`; `dir` is the site root's folder in the repository, default `""`. |
| `theme` | `{name, options}` | | The theme package or folder, and the options handed to it unread. The theme validates its own options. |
| `search` | `false` or `{text}` | `{}` | `false` builds no search index. `text` is the most characters of a page's body the index keeps (default `300`); titles and headings are always indexed. |
| `redirects` | map of path to path or URL | `{}` | Redirect pages: each key is an old path under `base`, each value a path on the site or an `https` URL. |
| `outputs` | map of name to boolean | every output on | Turns one output off by its name, such as `twins: false`. The names are in [Outputs](#outputs). |

```yaml
title: Beacon
description: Documentation for the Beacon deploy CLI.
url: https://example.com
base: /beacon
lang: en
source: docs
navigation: _data/navigation.yml
repository:
  url: https://github.com/example/beacon
  branch: main
  dir: docs
defaults:
  - path: ""
    values:
      layout: doc
search:
  text: 300
redirects:
  /old/: /new/
outputs:
  twins: false
```

`mizzen.config.ts` is not a second config file. It holds code only: the site's plugins, default-exported as `{ plugins: [...] }`. It cannot set a key of `mizzen.yml`, so every setting stays readable without running the site's code.

## Programmatic API

The package exposes two entry points today:

| Entry | Exports |
| --- | --- |
| `@velella/mizzen` | `version`. |
| `@velella/mizzen/contracts` | The frozen contract types, type-only. |

Inside the repository, each stage is a function with typed input and output:

| Function | File | Returns |
| --- | --- | --- |
| `build(options)` | `src/pipeline/build.ts` | `BuildResult`: the output folder, every file written (sorted), and every diagnostic. |
| `buildModel(root)` | `src/model/build.ts` | `ModelResult`: the complete site model plus diagnostics. It parses, renders Markdown, and builds navigation, but writes nothing. |
| `applyFacts({ site, root, sourceDir, dir? })` | `src/model/facts.ts` | `ApplyFactsResult`: the site with each derived fact's value at `data[fact.name]`, plus diagnostics. `buildModel` calls it. |
| `loadConfig(root, options?)` | `src/config/load.ts` | `LoadConfigResult`: a complete `SiteConfig` after defaults, plus diagnostics. |
| `loadRegistry(themeRoot)` | `src/render/registry.ts` | `ThemeRegistry`: the theme manifest, layouts, chrome, and components. |
| `loadCodeConfig(root, options?)` | `src/plugins/hooks.ts` | `LoadedCode`: the site's plugins and diagnostics. See [Plugins](#plugins). |

`build()` takes:

- `root`: the site root, the folder that holds `mizzen.yml`.
- `out`: the output folder, replaced as a whole. It must be outside `source`, or its first segment must start with `_` or `.`, as in `_site`.
- `themeRoot`: the theme's root folder, which holds `src/index.ts` and the `layouts/`, `chrome/`, and `components/` folders.
- `themeFiles`: theme files to copy, as paths relative to `themeRoot`; each lands under `assets/theme/` with its hash in the name.
- `defaultLayout`: the layout for a page that names none; without it such a page is an error.
- `outputsDir`: the folder outputs are read from; default `src/outputs/`.

Every output runs first, in memory, and its files are checked: a path outside `out` is an error, and so is a path two outputs both write (the first one wins). Then the site is written to a staging folder beside `out` and swapped in only when complete. A site's own file wins over an output's file at the same path, with no diagnostic. Problems in content and theme come back as diagnostics; a throw means a bug, such as an output or layout that threw, and leaves `out` as it was.

<!-- readme-example: programmatic-build -->
```ts
import { build, type BuildResult } from "../src/pipeline/build.ts";

/** Builds a site and returns what was written. */
export function buildSite(root: string, out: string, themeRoot: string): Promise<BuildResult> {
  return build({ root, out, themeRoot, defaultLayout: "doc" });
}
```

`buildModel()` is the API for a tool that reads the site without writing it, such as a linter or an MCP server. Its diagnostics are the same ones a build reports.

## Outputs

Each `*.ts` file in an outputs folder is one unit. The pipeline finds them by listing the folder in file-name order; adding one needs no edit to a shared index. A file exports exactly one `Output`, under any export name, and its `name` must equal the file name without `.ts`. A file that exports no output is a helper and is not run.

| Name | Writes |
| --- | --- |
| `agents-md` | `AGENTS.md`, a guide to the built site for agents. |
| `context-pack` | `pack/<topic>.md` for each topic in `_data/context-packs.yml`: the best pages for the topic, trimmed to its token budget, with each page's URL and source path. |
| `html` | One HTML file per document page, at the page's pretty URL. |
| `llms` | `llms.txt`, following llmstxt.org. |
| `llms-full` | `llms-full.txt`, every page's Markdown in one file. |
| `manifest` | `.slipway/manifest.json`, the page list and per-page source and HTML hashes. |
| `opensearch` | `opensearch.xml`, the site's search as an OpenSearch provider, when the config has `url`. |
| `page-agent` | One JSON file per document page with an `agent:` block (`agent.json` for a pretty URL): URL, source, and the page's instructions. |
| `page-json` | One JSON file per document page (`index.json` for a pretty URL): URL, title, description, headings, source, last change, and estimated tokens. |
| `robots` | `robots.txt`, with the sitemap address when the config has `url`. |
| `search` | `pagefind/`, a static search index. |
| `sitemap` | `sitemap.xml`. |
| `sourcemap` | `sourcemap.json`, the line-exact source map ([format](https://github.com/arminazimi/slipway/blob/main/spec/sourcemap/v0.md)). |
| `twins` | One Markdown twin per document page: the same URL with `.md` in place of the HTML file. |

`outputs` in `mizzen.yml` turns one off by name:

```yaml
outputs:
  twins: false
  search: false
```

The contract is in `src/contracts/output.ts`:

```ts
interface Output {
  readonly name: string;
  run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]>;
}
```

`ctx.renderPage(page)` renders a page to a complete HTML document through the theme. `ctx.report(diagnostic)` records a finding; an output reports a content problem instead of throwing. `run()` returns files sorted by path, each `{ path, contents }`, where `path` is relative to the output folder and uses `/`, and `contents` is a string (UTF-8, LF) or a `Uint8Array`.

A custom outputs folder is passed to `build()` as `outputsDir`. It replaces the built-in folder for that build, so a custom output can either live beside the built-ins or be the whole set.

<!-- readme-example: custom-output -->
```ts
import type { Output } from "@velella/mizzen/contracts";

/** Writes feed.txt; the file name must be feeds.ts, so the output's name is feeds. */
export const feeds: Output = {
  name: "feeds",
  async run() {
    return [{ path: "feed.txt", contents: "hello\n" }];
  },
};
```

## Plugins

A site adds behavior from `mizzen.config.ts` at its root. The file default-exports its plugins and nothing else:

```ts
import type { Plugin } from "@velella/mizzen/contracts";

export default {
  plugins: [
    /* Plugin objects, in the order they run. */
  ],
};
```

A site without the file is an ordinary site: no plugins, no diagnostics. A file Node cannot import, or a default export without a `plugins` list, is one error naming the file. An entry that is not a plugin is dropped with an error and the sound entries still run.

A plugin is a `name` for diagnostics and any of three hooks. Each hook receives a value and returns the value the next plugin receives; none mutates its input. A hook may be async, and it is awaited before the next plugin runs.

| Hook | Runs | Receives | Returns |
| --- | --- | --- | --- |
| `content` | Once per page, after its Markdown is parsed and before the site model is assembled. | `Page` | `Page` |
| `model` | Once, after the site model is assembled and before anything is rendered. | `Site` | `Site` |
| `outputs` | Once, with the files the outputs produced and the site they came from, before the files are written. | `readonly OutputFile[]`, `Site` | `readonly OutputFile[]` |

A hook that throws, or returns something the stage cannot use, is an error naming the plugin. The value the stage carried before that plugin is kept and the plugins after it still run, so one bad plugin costs its own work and nothing more. The diagnostic id is `plugin.hook-failed`.

<!-- readme-example: plugin -->
```ts
import type { Plugin } from "@velella/mizzen/contracts";

const banner: Plugin = {
  name: "banner",
  content(page) {
    return { ...page, frontMatter: { ...page.frontMatter, banner: true } };
  },
};

export default { plugins: [banner] };
```

The loader and the hook runners are `loadCodeConfig()`, `runContentHooks()`, `runModelHooks()`, and `runOutputsHooks()` in `src/plugins/hooks.ts`. Each runner returns `{ value, diagnostics }` and never fails the stage. The pipeline does not call them yet: `build()` does not load `mizzen.config.ts` in this version, so a site's plugins are not applied by the CLI until that wiring lands.

## Layout

- `src/index.ts`: the public entry. It exports only `version` for now.
- `src/contracts/`: the frozen types every stage shares; types only, nothing runs.
- `src/config/`, `src/content/`, `src/markdown/`, `src/model/`, `src/nav/`, `src/pipeline/`, `src/plugins/`, `src/render/`, `src/outputs/`, `src/source/`: the pipeline's stages and units.
- `src/model/facts/`: one file per derived fact, merged into `Site.data` at the end of the model stage; see its [README](src/model/facts/README.md) and [ADR 0028](https://github.com/arminazimi/slipway/blob/main/docs/adr/0028-derived-facts.md).
- `src/outputs/`: one file per output; see its [README](src/outputs/README.md).
- `bin/slipway.ts`: the `mizzen` command.
- `schema/config.schema.json`: the site config schema.
- `test/`: `*.test.ts` files for `node --test`.

## Contributing

Bug reports, fixes, and docs improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[Apache-2.0](LICENSE).

---

<p align="center">Mizzen is part of <a href="https://velella.sh">Velella</a>. The mast behind the sail.</p>
