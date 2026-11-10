---
title: Outputs
description: The files every build writes besides the HTML pages, and how to turn one off or add your own.
layout: doc
permalink: /outputs/
---

Each `*.ts` file in an outputs folder is one unit. The pipeline finds them by listing the folder in file-name order; adding one needs no edit to a shared index. A file exports exactly one `Output`, under any export name, and its `name` must equal the file name without `.ts`. A file that exports no output is a helper and is not run.

| Name | Writes |
| --- | --- |
| `agents-md` | `AGENTS.md`, a guide to the built site for agents. |
| `context-pack` | `pack/<topic>.md` for each topic in `_data/context-packs.yml`: the best pages for the topic, trimmed to its token budget, with each page's URL and source path. |
| `html` | One HTML file per document page, at the page's pretty URL. |
| `llms` | `llms.txt`, following llmstxt.org. |
| `llms-full` | `llms-full.txt`, every page's Markdown in one file. |
| `manifest` | `.mizzen/manifest.json`, the page list and per-page source and HTML hashes. |
| `opensearch` | `opensearch.xml`, the site's search as an OpenSearch provider, when the config has `url`. |
| `page-agent` | One JSON file per document page with an `agent:` block (`agent.json` for a pretty URL): URL, source, and the page's instructions. |
| `page-json` | One JSON file per document page (`index.json` for a pretty URL): URL, title, description, headings, source, last change, and estimated tokens. |
| `robots` | `robots.txt`, with the sitemap address when the config has `url`. |
| `search` | `pagefind/`, a static search index. |
| `sitemap` | `sitemap.xml`. |
| `sourcemap` | `sourcemap.json`, the line-exact source map (format). |
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
