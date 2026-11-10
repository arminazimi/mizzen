---
title: Reading time
description: A chip under the title with the page's reading time, and its word count when asked.
layout: doc
permalink: /components/reading-time/
---

The doc layout puts a reading-time chip under the title on every doc page that has an entry in
`site.data["reading-time"]`, the fact the engine also writes to `reading-time.json`. The chip says
how long the page takes to read and, when enabled, how many words it has. A page with no entry, or
with a reading time of 0, gets no chip.

## Syntax

The layout adds it automatically. For a manual chip inside a page:

```markdown
:::reading-time{minutes=3 words=600 showWords}
:::
```

The numbers can also come from the page's data instead: `::reading-time{showWords}` shows the
page's own reading time and word count.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `minutes` | number | the page's reading time | The reading time in whole minutes. Overrides the stored value. |
| `words` | number | the page's word count | The word count. Overrides the stored value. |
| `showWords` | word | off | Show the word count next to the reading time. |

## Example

:::reading-time{minutes=3 words=600 showWords}
:::

:::reading-time{minutes=1}
:::

## Notes

- The chip reads `site.data["reading-time"]` by the page's exact URL, including `base`. Three
  shapes work: the engine's array of `{ url, words, minutes }`, the same list under `pages`, and a
  `pages` map keyed by the page URL. This lets a site override the numbers in
  `_data/reading-time.yml`.
- The text comes from `i18n/*.json` in the page's language. English distinguishes one minute from
  several; Persian uses one form for 0 and 1 and the same noun above that, since a Persian noun
  stays singular after a numeral; Arabic follows the CLDR zero, one, two, few (3 to 10), many
  (11 to 99), and other forms.
- A negative or unreadable `minutes` or `words` value falls back to the page's data, and a
  non-positive reading time renders nothing.
