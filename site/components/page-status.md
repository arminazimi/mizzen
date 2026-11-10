---
title: Page status
description: An experimental, beta, or deprecated banner above the title, from front matter.
layout: doc
permalink: /components/page-status/
---

A page-status banner tells a reader that a page is experimental, beta, or deprecated. The doc layout reads the page's front matter and puts the banner above the title; the same component can be shown inside a page with a directive.

## Syntax

In front matter:

```yaml
status: beta
since: 0.3.0
```

To preview one inside a page:

```markdown
:::page-status{status=deprecated since="0.2.0" replaced_by="/components/callout/"}
:::
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `status` | `experimental`, `beta`, or `deprecated` | none | The banner's kind. Any other value renders nothing. |
| `since` | string | none | The version when the status was set, shown as "Since 0.3.0". |
| `replaced_by` | site path or `https` URL | none | The replacement page. Only a deprecated page shows it. |

## Example

:::page-status{status=experimental since="0.3.0"}
:::

:::page-status{status=deprecated since="0.2.0" replaced_by="/components/callout/"}
:::

## Notes

- `status`, `since`, and `replaced_by` are front matter keys. The directive is for a preview inside a page; a real page uses front matter.
- A `replaced_by` that is not a root-relative path or an `https` URL is shown as text, not a link.
- Remove the status when the feature is stable. A beta banner left on a finished page is worse than no banner.
