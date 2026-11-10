---
title: Symbol popover
description: An inline symbol whose signature and reference appear on hover or keyboard focus.
layout: doc
permalink: /components/symbol-popover/
---

A symbol popover names a function, type, or option in running text. The chip shows the name; hovering it, or moving keyboard focus to it, reveals the signature and a link to the reference page. The tooltip is hidden and shown with CSS, so it works without JavaScript.

## Syntax

```markdown
::symbol-popover{name="runExample" signature="runExample(input: Input): Promise<Result>" href="/reference/runner/"}
```

It is a leaf directive, so it stands on its own line with a blank line before and after.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `name` | string | required | The symbol's name, shown on the chip. Without it the component renders nothing. |
| `signature` | string | empty | The signature shown in the tooltip, as code text. |
| `href` | string | none | A reference page. Root-relative or `http`/`https`; any other URL renders no link. |

Quote a value that has spaces, braces, or angle brackets: `signature="run(input: Input): Result"`.

## Example

::symbol-popover{name="runExample" signature="runExample(input: Input): Promise<Result>" href="/reference/runner/"}

::symbol-popover{name="Result" signature="type Result = { ok: boolean; value: string }"}

## Notes

- The tooltip opens on `:hover` and `:focus-within`, so the chip is in the tab order and a keyboard user can read it.
- With JavaScript, Escape hides the tooltip until focus or the pointer leaves the chip. The island never moves focus and never traps it.
- A symbol inside an ordinary fenced code block needs engine markers, which are not in scope yet. The directive is the supported form for now.
