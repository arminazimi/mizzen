---
title: Version badge
description: A small badge that says when a feature was added, changed, or removed.
layout: doc
permalink: /components/version-badge/
---

A version badge shows the release a change landed in, as `v0.3`. It is a leaf directive, so it has no body and takes the version from `version`.

The icon and the sentence a screen reader hears both come from the variant, so the three variants do not depend on color alone.

## Syntax

```markdown
::version-badge{version=0.3}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `version` | string | none | The version shown after `v`, such as `0.3`. Missing or blank renders nothing. |
| `variant` | `added`, `changed`, or `removed` | `added` | The icon and the screen-reader sentence. An unknown value is `added`. |
| `block` | bare word | inline | Its presence puts the badge on its own line instead of inline. |

The screen reader hears "Added in version 0.3" (or the matching sentence) in the page's language.

## Example

::version-badge{version=0.3}

::version-badge{version=0.3 variant=changed}

::version-badge{version=0.3 variant=removed}

::version-badge{version=0.4 variant=added block}

```markdown
::version-badge{version=0.3}

::version-badge{version=0.3 variant=changed}

::version-badge{version=0.3 variant=removed}

::version-badge{version=0.4 variant=added block}
```

## Notes

- The directive is block-level in Markdown: put it on its own line, with a blank line before and after. It renders inline; add `block` for its own line.
- Write the version without the `v`; the badge adds it.
- A version badge is a label, not a link. Link to the release notes in the sentence around it.
