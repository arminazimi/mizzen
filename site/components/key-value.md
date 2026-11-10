---
title: Key-value list
description: Properties, options, or metadata as a two-column list of keys and values that folds to one column on narrow screens.
layout: doc
permalink: /components/key-value/
---

A key-value list shows pairs: a property and its type, an option and its default, a field and its value. It is a description list, so each key is a `<dt>` and each value a `<dd>`, and it reads correctly without CSS or JavaScript.

## Syntax

```markdown
:::key-value
Version: 1.0
License: MIT
:::
```

The `items` prop takes the same pairs as a JSON array, for content that comes from data or a generator:

```markdown
::key-value{items='[{"key":"Version","value":"1.0"},["License","MIT"]]'}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `items` | string | — | A JSON array of pairs, each `{"key":"…","value":"…"}` or `["…","…"]`. When it is missing or unreadable, the `key: value` lines in the body are used. |

## Example

:::key-value
Version: 1.0
License: MIT
Built with: Slipway
:::

The list keeps the order you write, including duplicate keys. Each line is split at its first colon, the key and value are trimmed, and blank lines are skipped.

## Notes

- Use it for a short set of properties or metadata, not for tabular data with several columns; a [table](./table/) is the right component there.
- A value is plain text. To link or style part of a value, use Markdown elsewhere or a [schema table](./schema-table/) when the data is a JSON Schema.
- On a narrow screen the two columns become one, and long values wrap instead of widening the page.
