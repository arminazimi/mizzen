---
title: Steps
description: A numbered sequence or tutorial, drawn from an ordered Markdown list.
layout: doc
permalink: /components/steps/
redirect_from:
  - /blocks/steps/
---

Steps turn an ordered list into a numbered sequence with a line between the numbers. It is for a procedure the reader follows in order: install, configure, build.

## Syntax

```markdown
:::steps
1. Install the package.
2. Add a `slipway.yml`.
3. Run the build.
:::
```

## Options

None.

## Example

:::steps
1. Create the folder.
2. Add `slipway.yml` with the site's title and language.
3. Run `npm create slipway` or build the site with the engine.
4. Open the output folder and check the first page.
:::

## Notes

- The body must be an ordered list. Each item is one step; the numbers come from CSS for the page's language.
- The directive is for a sequence, not for a bulleted list. For options or features, a plain list reads better.
- A step can hold a paragraph, a code block, or a callout; keep each step to one action.
