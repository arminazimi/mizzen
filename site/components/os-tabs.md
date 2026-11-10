---
title: OS tabs
description: Install instructions grouped by operating system, defaulting to the reader's system and remembering a manual choice.
layout: doc
permalink: /components/os-tabs/
---

OS tabs group install instructions by operating system. The reader sees the tab for their system, and a choice they make by hand is remembered on the pages they open next. Without JavaScript every section stays visible under its title, so nothing is hidden behind a control that does not run.

## Syntax

A container directive whose body holds one `##` or `###` heading per operating system. The heading's text is the tab label and starts that section:

````markdown
:::os-tabs{id="install-slipway"}
### macOS

```bash
brew install slipway
```

### Windows

```powershell
winget install slipway
```

### Linux

```bash
curl -fsSL https://get.slipway.dev | sh
```
:::
````

The labels macOS, Windows, and Linux (also `Mac`, `Win32`, `Ubuntu`, and a few other names) tell the island which tab each section is. A heading it does not recognise still becomes a tab, but the island never selects it by name.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `id` | string | `os-tabs` | Prefix for the group's element ids. Give each group on a page its own id. |

## Example

:::os-tabs{id="install-example"}
### macOS

```bash
brew install slipway
```

### Windows

```powershell
winget install slipway
```

### Linux

```bash
curl -fsSL https://get.slipway.dev | sh
```
:::

## Notes

- The tab list starts `hidden`; without JavaScript the sections stack, each under its label.
- The island reads the browser's platform, chooses that tab, and falls back to the first tab when it cannot tell.
- Choosing a tab by hand is remembered in `localStorage["slipway-os-tabs"]` and switches every OS tab group on the page and on later pages that offers the same system.
- Arrow keys move between tabs, `Home` and `End` go to the ends, and the arrows follow the reading direction in right-to-left pages.
- Component islands are not wired into built pages yet, so a built site shows the no-JavaScript state — every section stacked — until island wiring lands.
- Use [code tabs](./code-tabs/) when the choice is a language or package manager rather than an operating system.
