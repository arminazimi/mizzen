---
title: Table
description: Markdown tables in a labelled, keyboard-scrollable region, styled by the theme.
layout: doc
permalink: /components/table/
---

A table shows data in rows and columns. The theme wraps every Markdown table in a scroll region with an accessible label, so a wide table scrolls inside the article instead of widening the page.

## Syntax

A GFM pipe table:

```markdown
| Environment | Target |
| --- | --- |
| staging | `s3://staging` |
| production | `s3://production` |
```

There is no directive.

## Options

None. The table's accessible name comes from its first row, or from the surrounding heading in the theme's wrapper.

## Example

| Environment | Target | Hooks |
| --- | --- | --- |
| `staging` | `s3://beacon-staging` | none |
| `production` | `s3://beacon-prod` | `after` |

## Notes

- Keep the table narrow enough to scan. For two columns of prose, a definition list or two paragraphs may read better.
- The alignment row is required; `---` on its own is enough.
- Inline code in cells is the clearest way to name a field, a path, or a value.
- A table is never a layout tool; use [steps](./steps/) or a list for a sequence.
