---
title: Plugins
description: Change pages, the site model, or the written files from mizzen.config.ts.
layout: doc
permalink: /plugins/
---

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

The loader and the hook runners are `loadCodeConfig()`, `runContentHooks()`, `runModelHooks()`, and `runOutputsHooks()` in `src/plugins/hooks.ts`. Each runner returns `{ value, diagnostics }` and never fails the stage. `build()` loads `mizzen.config.ts` and runs every hook in the order above, once per stage, before anything is written. A site with a code file always builds cold, since what its imports read cannot be part of the cache key, and the file itself is never copied into the output.
