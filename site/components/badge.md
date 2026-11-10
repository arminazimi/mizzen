---
title: Badge
description: A small inline-style label for a version, a status, or a beta marker.
layout: doc
permalink: /components/badge/
redirect_from:
  - /blocks/badge/
---

A badge is a short label on its own line: a version, a status, or a beta marker. It is a leaf directive, so it has no body and takes its text from `label`.

## Syntax

```markdown
::badge{label="New" variant=tip}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `label` | string | empty | The text shown in the badge. |
| `variant` | `note`, `tip`, `important`, `warning`, or `caution` | `note` | The color and tone. An unknown value is a note. |

Quote a label that has spaces: `label="Requires 0.3"`.

## Example

::badge{label="Beta" variant=important}

::badge{label="New" variant=tip}

```markdown
::badge{label="Beta" variant=important}

::badge{label="New" variant=tip}
```

## Notes

- The directive is block-level: put it on its own line, with a blank line before and after.
- The inline `:badge[New]{variant=tip}` form is not an engine directive. Use the leaf form above.
- A badge is a label, not a link. Link to the thing it names in the sentence around it.
