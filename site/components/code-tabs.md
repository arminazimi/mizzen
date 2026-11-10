---
title: Code tabs
description: One example in several languages or package managers, as tabs that stack without JavaScript.
layout: doc
permalink: /components/code-tabs/
redirect_from:
  - /blocks/code-group/
---

Code tabs group several code blocks under one set of labels, so the same example can show npm, pnpm, and yarn without taking three times the height. Without JavaScript every block stays visible under its title; the island turns the titles into a WAI-ARIA tab list.

## Syntax

A container directive whose body is one or more fenced code blocks:

````markdown
:::code-tabs{labels='["npm","pnpm"]'}
```bash
npm install slipway
```

```bash
pnpm add slipway
```
:::
````

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `labels` | JSON array of strings | the block's position | One label per block, in order: `'["npm","pnpm"]'`. |
| `id` | string | `code-tabs` | Prefix for the group's element ids. Give each group on a page its own id. |

The value of `labels` is JSON, so use single quotes around it in the directive and double quotes inside. A missing or empty label reads as the block's position.

## Example

:::code-tabs{labels='["npm","pnpm"]'}
```bash
npm install slipway
```

```bash
pnpm add slipway
```
:::

## Notes

- The tab list starts `hidden`; without JavaScript the panels stack, each under its label.
- Arrow keys move between tabs, `Home` and `End` go to the ends, and the arrows follow the reading direction in right-to-left pages.
- Choosing a label in one group switches every group on the page that offers it, and the choice is remembered on later pages.
- The blocks are plain fenced code inside the group; the `code` component does not run inside code tabs yet, so the tabs show the fence without Shiki colors.
