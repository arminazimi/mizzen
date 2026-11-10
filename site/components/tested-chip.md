---
title: Tested chip
description: A small chip beside a code block that says whether its examples passed, with when they last passed.
layout: doc
permalink: /components/tested-chip/
---

A tested chip shows the result of a page's examples in one line: an icon, the word "Tested", and how many examples passed or failed. It is an inline chip, sized to sit next to a code block or under it. It renders nothing when the block or page has no run examples.

The icon's shape, the visible label, and the counts carry the result, so it never depends on colour alone.

## Syntax

```markdown
::tested-chip{passed=2 failed=0 lastPassed=2026-11-09}
```

`tested-chip` is a leaf directive: it has no body and takes every value from its attributes.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `passed` | count | none | Examples that passed. |
| `failed` | count | none | Examples that failed. |
| `lastPassed` | ISO date | none | When the examples last passed, shown as a tooltip and read by screen readers. |

A count is a non-negative integer; anything else counts as `0`. When `passed` and `failed` are both absent, the chip reads the page's entry in `site.data.examples`. When the props are present they win.

The chip is hidden when the total is `0`, and it reads as failed when any example failed.

## Example

::tested-chip{passed=2 failed=0 lastPassed=2026-11-09}

::tested-chip{passed=0 failed=1 lastPassed=2026-11-09}

::tested-chip{passed=2 failed=1 lastPassed=2026-11-09}

```markdown
::tested-chip{passed=2 failed=0 lastPassed=2026-11-09}

::tested-chip{passed=0 failed=1 lastPassed=2026-11-09}

::tested-chip{passed=2 failed=1 lastPassed=2026-11-09}
```

## Notes

- The tooltip is `Last passed <date>`, in the page's calendar: Gregorian in English, Jalali in Persian, and Hijri in Arabic. It is also available to a screen reader.
- A page can supply the result with `_data/examples.yml`, keyed by the page's URL. The engine's `examples.json` report is a separate open issue (#1465), so this fallback reads data a site writes today.

  ```yaml
  /guide/install/:
    passed: 2
    failed: 0
    lastPassed: 2026-11-09
  ```

- Automatic per-block placement needs the engine's example markers (N01/N06), which say which code blocks are runnable. Until they land, place the chip next to the block with this directive.
- Use a [badge](./badge/) for a status label that is not about examples.
