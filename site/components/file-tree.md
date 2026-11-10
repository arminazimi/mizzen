---
title: File tree
description: A nested Markdown list drawn as a folder structure, with a note on each entry.
layout: doc
permalink: /components/file-tree/
redirect_from:
  - /blocks/file-tree/
---

A file tree turns a nested list into a folder structure with icons, indentation, and a muted note on each entry. It is a presentational view of a list, so it reads the same without JavaScript.

## Syntax

```markdown
:::file-tree{label="Project layout"}
- content/ # the pages of the site
  - **index.md** # the home page
- slipway.yml
:::
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `label` | string | `File tree` | The tree's accessible name. |

## Example

:::file-tree{label="Site layout"}
- content/ # pages and posts
  - **index.md** # the home page
  - guides/
    - install.md
- slipway.yml # site settings
- assets/
  - logo.svg
:::

## Notes

- The body is a nested bullet list. Each item is one row; nested items are its children.
- A name ending in `/` is a folder. An entry with nested items is a folder even without the slash.
- Text after ` # ` (with a space on each side) is a note on that row.
- A name in bold, `**name**`, is highlighted as the file the page is about.
- Keep the tree to the files a reader needs. A whole repository dump hides the three lines that matter.
