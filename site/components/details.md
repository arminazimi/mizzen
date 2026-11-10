---
title: Details
description: A native disclosure that the reader can open and close, with a Markdown body.
layout: doc
permalink: /components/details/
---

A details block hides a passage behind a summary line. It is the native `<details>` element, so it opens and closes without JavaScript, and the browser can open it when the reader follows an anchor inside it.

## Syntax

```markdown
:::details{summary="Install on Windows" open}
Run the installer, then restart the terminal.
:::
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `summary` | string | `Details` | The text of the disclosure control. |
| `open` | bare word | closed | Its presence starts the block expanded. |

## Example

:::details{summary="Show the full command"}
```bash
node packages/engine/bin/slipway.ts build site --out dist
```
:::

:::details{summary="This one starts open" open}
The `open` word is all it takes. Leave it out for a block that starts closed.
:::

## Notes

- The body is Markdown, including lists, code, and links.
- Use details for optional depth, not for information every reader needs. A page read without JavaScript still shows the summary and opens on a click.
- Never put one details block inside another merely to save space; nested disclosures are hard to scan.
