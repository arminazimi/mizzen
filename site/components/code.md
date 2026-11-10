---
title: Code
description: A code block highlighted at build time in light and dark, with a copy button when JavaScript runs.
layout: doc
permalink: /components/code/
redirect_from:
  - /blocks/annotations/
  - /blocks/diff/
---

A code block shows source with the theme's highlighting colors. Highlighting runs at build time and emits one set of colors for light and one for dark, so switching the theme needs no rebuild and no highlighting script in the browser.

## Syntax

Wrap a fenced block in the `code` directive and name its language:

````markdown
:::code{lang="ts"}
```ts
const answer: number = 42;
```
:::
````

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `lang` | string | the fence's language, else `text` | The Shiki language. An unknown language falls back to plain text. |

## Example

:::code{lang="ts"}
```ts
type Component = { name: string; options: Record<string, string> };

export function render(component: Component): string {
  return `${component.name}:${JSON.stringify(component.options)}`;
}
```
:::

:::code{lang="diff"}
```diff
- publish: build
+ publish: dist
```
:::

## Notes

- The copy button is made by JavaScript and starts hidden. Without JavaScript the code still reads and selects by hand.
- A `diff` fence keeps its `+` and `−` lines. Use it to show a change to a file.
- Fence meta such as `title="…"`, line marks, and `ins`/`del` is parsed by the engine, but the current component does not render it. Put a file name in the sentence above the block.
- The block keeps its source span, so the page footer can edit the exact block with an agent.
