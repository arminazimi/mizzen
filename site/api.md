---
title: Programmatic API
description: Build or read a site from your own code with @velella/mizzen.
layout: doc
permalink: /api/
---

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
| `loadCodeConfig(root, options?)` | `src/plugins/hooks.ts` | `LoadedCode`: the site's plugins and diagnostics. See [Plugins](/plugins/). |

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
