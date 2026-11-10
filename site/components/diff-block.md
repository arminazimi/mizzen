---
title: Diff block
description: A diff with added, removed, and context lines, named for screen readers and copyable as the new file.
layout: doc
permalink: /components/diff-block/
---

A diff block shows a change to a file as an ordered list: added lines, removed lines, and the context
around them. Each line carries a visible `+` or `−`, added and removed lines carry a "Added:" or
"Removed:" prefix for screen readers, and the copy button takes the new version of the file.

## Syntax

Write the lines in the directive's body, or wrap a `diff` fence in it:

````markdown
:::diff-block
```diff
 publish:
-  dir: build
+  dir: dist
 keep:
```
:::
````

Each line starts with `+` for an added line, `-` for a removed line, or a space for context. A line
with no marker is context too. File and hunk headers (`diff --git`, `---`, `+++`, `@@`) are shown with
the diff but left out of the copy.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `id` | string | derived from the diff | Prefix for the block's label id. Give each identical block on a page its own id. |

## Example

:::diff-block
```diff
--- a/slipway.yml
+++ b/slipway.yml
 publish:
-  dir: build
+  dir: dist
 keep:
```
:::

The copy button starts hidden and the island reveals it when the browser can write to the clipboard.
Without JavaScript the list still shows the whole diff and the text can be selected by hand; the copy
text is also on the button's `data-diff` attribute.
