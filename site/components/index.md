---
title: Components
description: Every component the Lateen theme provides, with its syntax, options, and a live example.
layout: doc
permalink: /components/
redirect_from:
  - /blocks/
  - /blocks/audio/
  - /blocks/chart/
  - /blocks/citation/
  - /blocks/compare/
  - /blocks/download/
  - /blocks/gallery/
  - /blocks/hero/
  - /blocks/logos/
  - /blocks/people/
  - /blocks/pricing/
  - /blocks/pull-quote/
  - /blocks/stats/
  - /blocks/testimonial/
  - /blocks/timeline/
---

Components are the pieces pages use inside their content: a callout, a code tab, an endpoint, a file tree. Each page below shows the Markdown you write, every option it reads, and a live example.

The engine turns a directive into the component whose folder has the same name under `packages/theme/components/`. A container directive (`:::name` … `:::`) wraps a Markdown body; a leaf directive (`::name`) stands alone on its own line. Directive attributes are the component's options: `:::callout{type=warning}`.

| Component | Use it for |
| --- | --- |
| [Badge](./badge/) | A short status label, such as a version or a beta marker. |
| [Callout](./callout/) | A note, tip, important point, warning, or caution. |
| [Cards](./cards/) | A responsive grid of linked cards, used by the home layout. |
| [Changelog entry](./changelog-entry/) | One release with a version, a date, and categories. |
| [Code](./code/) | Code highlighted at build time, with a copy button when JavaScript runs. |
| [Code tabs](./code-tabs/) | The same example in several languages or package managers, as tabs. |
| [Details](./details/) | A native disclosure that the reader can open and close. |
| [Diff block](./diff-block/) | Added, removed, and context lines, with a copy of the new file. |
| [Drift banner](./drift-banner/) | A warning above a page whose documentation has drifted from the code. |
| [Embed](./embed/) | A video or another page in a lazy iframe. |
| [Endpoint](./endpoint/) | An HTTP method, path, parameters, and body for API reference pages. |
| [Figure](./figure/) | An image with alt text, a caption, and a credit, in light and dark. |
| [File tree](./file-tree/) | A folder structure with a note per entry. |
| [Heading anchor](./heading-anchor/) | A link icon on every h2 to h4, added automatically. |
| [Kbd](./kbd/) | A keyboard key or key combination. |
| [Key-value list](./key-value/) | Properties, options, or metadata as a two-column list of keys and values. |
| [Link card](./link-card/) | One link that reads as a card, for next steps and related pages. |
| [Mermaid](./mermaid/) | A Mermaid diagram rendered to inline SVG at build time, with its source kept. |
| [OS tabs](./os-tabs/) | Install instructions grouped by operating system, defaulting to the reader's system. |
| [Output block](./output-block/) | The result of a command, apart from the command above it. |
| [Page status](./page-status/) | An experimental, beta, or deprecated banner from front matter. |
| [Reading time](./reading-time/) | A chip under the title with the page's reading time and word count. |
| [Schema table](./schema-table/) | A JSON Schema from `_data` as a table of properties. |
| [Status banner](./status-banner/) | A page-level deprecated, experimental, or old-version banner, with a replacement link. |
| [Steps](./steps/) | A numbered sequence or tutorial. |
| [Symbol popover](./symbol-popover/) | A symbol whose signature and reference page appear on hover or focus. |
| [Table](./table/) | Markdown tables in a labelled, keyboard-scrollable region. |
| [Tabs](./tabs/) | Any sections as tabs, following one chosen label across the page and later pages. |
| [Tags](./tags/) | A wrapping list of tag chips, as links or plain text. |
| [Terminal](./terminal/) | A shell session with commands and their output. |
| [Tested chip](./tested-chip/) | The pass or fail result of a page's examples, next to a code block. |
| [Trust panel](./trust-panel/) | A chip under the title that opens the page's trust level, examples, drift, reviewer, and actions. |
| [Variables form](./variables-form/) | Inputs that fill a page's code-example variables with the reader's own values. |
| [Version badge](./version-badge/) | A version badge that says when a feature was added, changed, or removed. |
| [Version diff](./version-diff/) | A section-by-section comparison of two versions, with a text label for every change. |
| [Video](./video/) | A click-to-load video with a poster and a link that works without JavaScript. |

## Moving from the old blocks

The 0.2 theme had a larger set of blocks. Some became components; the rest have a lighter Markdown form or belong to a layout. Old URLs redirect to the page that replaces them.

| Old block | What to use now |
| --- | --- |
| Annotations, diff | [Code](./code/) |
| Audio | [Embed](./embed/) |
| Code group | [Code tabs](./code-tabs/) |
| Chart, compare, logos, pricing, stats | A [table](./table/) or a plain Markdown list. |
| Citation, download | A Markdown link. |
| Gallery | One [figure](./figure/) per image. |
| Hero | The [home layout](../../guides/) with `hero`, `actions`, and `sections` in front matter. |
| People, testimonial | A table, a blockquote, or a list. |
| Pull quote | A blockquote. |
| Timeline | An ordered list or [steps](./steps/). |
