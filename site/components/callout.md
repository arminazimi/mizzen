---
title: Callout
description: A note, tip, important point, warning, or caution with an icon and a color per kind.
layout: doc
permalink: /components/callout/
redirect_from:
  - /blocks/callout/
---

A callout sets a short passage apart from the prose: something to remember, try, or avoid. The five kinds match GitHub alerts, and both syntaxes render the same component.

## Syntax

A container directive:

```markdown
:::callout{type=warning title="Back up first"}
Run the migration on a copy of the database.
:::
```

A shortened directive, where the name is the type and the label is the title:

```markdown
:::tip[Check the version first]
The engine needs Node 24 or later.
:::
```

`:::note`, `:::tip`, `:::warning`, and `:::danger` (read as `caution`) all work this way. Text in
square brackets after the name is the title; without it the kind's default title is used. Every
other directive name is left alone.

A GitHub alert:

```markdown
> [!TIP]
> Run the build before you open a pull request.
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `type` | `note`, `tip`, `important`, `warning`, or `caution` | `note` | The icon, color, and default title. `danger` is read as `caution`. |
| `title` | string | the kind's name | Replaces the heading above the body. |

The defaults are **Note**, **Tip**, **Important**, **Warning**, and **Caution**. An unknown `type` falls back to `note`.

## Example

:::callout{type=tip title="Check the version first"}
The engine needs Node 24 or later. Run `node --version` before you install.
:::

:::callout{type=warning}
This option changes every page in the site.
:::

> [!CAUTION]
> Deleting the folder cannot be undone.

## Notes

- The body is Markdown, including paragraphs, lists, and code.
- A GitHub alert takes no options; its kind comes from the marker on the first line.
- The icon and the accent border are on the reading side in both directions, and the icons are symmetric, so no separate right-to-left markup is needed.
