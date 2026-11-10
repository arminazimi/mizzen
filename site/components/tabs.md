---
title: Tabs
description: Any sections of a page as accessible tabs, following one chosen label across the page and on later pages.
layout: doc
permalink: /components/tabs/
---

Tabs show one section at a time and let the reader pick another. They are for any content, not only code: install steps per platform, one topic per audience, or a short and a long explanation. A choice made by hand is remembered and applied to every tab group on the page that offers the same label.

## Syntax

A container directive whose body holds one `##` or `###` heading per section. The heading's text is the tab label and starts that section:

````markdown
:::tabs{group="install-beacon"}
### macOS

```bash
brew install beacon
```

### Linux

```bash
curl -fsSL https://get.example.com | sh
```

### Windows

```powershell
winget install beacon
```
:::
````

`group` is the group's key. Give each group on a page its own key. The heading text is also the label the island syncs on, so two groups that both offer `Linux` switch together.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `group` | string | generated | The group's key and the prefix for its element ids. |
| `id` | string | — | Fallback id prefix when `group` is absent. |

## Example

:::tabs{group="tabs-example"}
### macOS

Use Homebrew, or download the `darwin` archive.

### Linux

Use the `linux` archive and put `beacon` on your `PATH`.

### Windows

Use the `windows` archive and add its folder to `Path`.
:::

## Notes

- Without JavaScript the tab list stays hidden and every section shows stacked under its title, so nothing is locked behind a control that does not run.
- Choosing a tab by hand is remembered in `localStorage["slipway-tabs"]` and switches every group on the page and on later pages that offers the same label.
- `?tab=` in the URL chooses a label and beats what is remembered; `?lang=` works too, because the sync module is shared with code tabs.
- Arrow keys move between tabs, `Home` and `End` go to the ends, and the arrows follow the reading direction in right-to-left pages.
- Use [OS tabs](./os-tabs/) when the sections are operating systems and the reader's system should win, or [code tabs](./code-tabs/) when the choice is a language or package manager.
- Component islands are not wired into built pages yet, so a built site shows the no-JavaScript state — every section stacked — until island wiring lands.
