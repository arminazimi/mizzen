---
title: Link card
description: One link that reads as a card, with a title, a description, and an optional icon, for next steps.
layout: doc
permalink: /components/link-card/
---

A link card points to another page in a way that stands out from a paragraph: the whole card is one
link, with a title, a plain-text description, and an optional decorative icon. Use it for a "next
steps" or "keep reading" block.

## Syntax

```markdown
::link-card{href="/guide/install/" title="Install" description="Put Slipway in a project."}

::link-card{href="/reference/" title="Reference" description="Look up an option." icon="→"}
```

A card is a leaf directive: it stands alone on its own line. The whole card is a single `<a>`, so a
reader can tab to it and activate it from anywhere on the card.

## Options

| Name | Type | Required | What it does |
| --- | --- | --- | --- |
| `href` | URL | yes | Where the card goes: a path on this site (`/guide/`) or an `http`/`https` address. |
| `title` | string | yes | The card's heading and the link's accessible name. |
| `description` | string | no | Plain text under the heading. It is never parsed as markup, so a card cannot hold a nested link. |
| `icon` | HTML | no | A decorative icon, such as an inline SVG. It is hidden from assistive technology. |

A card renders nothing when `title` is missing or blank, or when `href` is missing or not a safe
URL. Root-relative paths and `http`/`https` addresses are allowed; `javascript:`, `data:`,
`mailto:`, relative paths, and protocol-relative `//host` addresses are not.

## Example

Place several cards in `<div class="link-card-grid">`: one column on a narrow screen, a grid as the
article widens. A single card needs no wrapper.

<div class="link-card-grid">

::link-card{href="/components/callout/" title="Callout" description="A note, tip, important point, warning, or caution." icon="→"}

::link-card{href="/components/code-tabs/" title="Code tabs" description="The same example in several languages, as tabs."}

</div>

## Notes

- The description is plain text. To link to more than one page, use one card per page or a Markdown
  list.
- The icon is decorative and may be any inline HTML, such as an SVG. Keep it small; the title is what
  names the link.
- For the home page's grid of sections, use the [cards](../cards/) layout instead. `link-card` is
  the directive a normal page writes; `cards` reads `sections` front matter. Both use the same tokens.
- Colors come from tokens, so light and dark mode keep contrast, and logical properties keep the card
  the same in right-to-left pages.
