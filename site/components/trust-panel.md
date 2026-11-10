---
title: Trust panel
description: A chip under the title that opens the page's trust level, examples, drift, reviewer, and actions.
layout: doc
permalink: /components/trust-panel/
---

A trust panel tells a reader how much to trust a page: the examples it tested, whether it has drifted
from the code it describes, who reviewed it last, and why it has its level. The doc layout puts the
chip under the title automatically when the page has an entry in `site.data.trust`; a page without an
entry gets no chip.

## Syntax

The layout adds it automatically. For a manual panel inside a page:

```markdown
:::trust-panel{level=verified reasons="3 of 3 examples passed|No drift findings" lastReviewer="Ada Lovelace"}
:::
```

The layout's panel reads the page's entry from `site.data.trust`, keyed by URL:

```yaml
# _data/trust.yml
"/guide/install/":
  level: verified
  reasons:
    - 3 of 3 examples passed
    - No drift findings
  lastReviewer: Ada Lovelace
```

The entry also works under a `pages` key, which wins when both shapes are present. When the engine's
`trust.json` output (N14) lands, it will write the same shape.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `level` | `verified`, `review due`, or `at risk` | none | The chip's level. Any other value renders nothing. Spaces, case, and `_` are ignored. |
| `reasons` | list, or a string split on line breaks or `|` | none | Why the page has this level. |
| `lastReviewer` | string | none | Who reviewed the page last. |

The examples row reads `site.data.examples` by page URL (`passed`, `failed`); the drift row reads
`site.data.drift` by page URL. A missing value says it is not recorded.

The action links are optional, from `theme.options.trust`; `{url}`, `{title}`, and `{source}` are
filled from the page, and a root-relative URL gets the site's `base`:

```yaml
theme:
  options:
    trust:
      contextPackUrl: "https://example.com/context?page={url}"
      suggestEditUrl: "https://github.com/example/docs/edit/main/{source}"
```

A link whose option is missing, or whose value is not a site path or an `https` URL, is left out.

## Example

:::trust-panel{level=verified reasons="3 of 3 examples passed|No drift findings" lastReviewer="Ada Lovelace"}
:::

:::trust-panel{level=review-due reasons="Reviewed more than 90 days ago."}
:::

## Notes

- The chip is a native `<details>` summary, so it opens with Enter, Space, or a click and closes with
  Escape without JavaScript. The island only adds the focus return to the chip.
- The text comes from `i18n/*.json` in the page's language, and the panel uses logical properties, so
  it works under RTL.
- Writing `trust.json` per page is a separate issue (N14). Until it lands, the layout's panel stays
  hidden unless the site writes `_data/trust.yml` or a page writes the directive.
