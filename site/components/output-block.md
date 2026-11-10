---
title: Output block
description: The result of a command, shown apart from the command above it, with a copy button that takes only the output.
layout: doc
permalink: /components/output-block/
---

An output block shows what a command printed. It is the result, not the input: the body is read as plain text, and a dashed edge and the surface color keep it visually distinct from the code block above it.

## Syntax

```markdown
:::output-block
Written 12 pages to dist
:::
```

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `label` | string | "Output" | The accessible name of the group. |

```markdown
:::output-block{label="Build result"}
Written 12 pages to dist
:::
```

## Example

:::output-block
Written 12 pages to dist
:::

:::output-block{label="Build result"}
Compiled 24 files
Copied 6 assets
:::

## Notes

- An empty body, or one that holds only whitespace, renders nothing.
- The body stays text: `<b>` written in it is shown as it is written, never turned into markup.
- The copy button copies the whole output and nothing else. It is made by JavaScript and starts hidden; the output still reads without it.
- Use a [terminal](./terminal/) when the commands and their output belong together in one block, and this block when only the result matters.
