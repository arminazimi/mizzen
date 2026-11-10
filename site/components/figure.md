---
title: Figure
description: An image with alt text, an optional caption and credit, and a second image for dark mode.
layout: doc
permalink: /components/figure/
redirect_from:
  - /blocks/figure/
---

A figure shows an image with the text around it: an alternative, a caption, and a credit. It can reserve layout space with its width and height, load lazily, and swap to another image in dark mode.

## Syntax

A container directive with a caption in the body:

```markdown
:::figure{src="/images/architecture.svg" alt="Three boxes in a row."}
The build reads the site, the theme, and the content.
:::
```

Or a leaf directive with `caption`:

```markdown
::figure{src="/images/architecture.svg" alt="Three boxes in a row." caption="The build pipeline"}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `src` | string | required | The image. Without it the figure renders nothing. |
| `src_dark` | string | none | The image shown in dark mode. When it equals `src`, one image is used in both modes. |
| `alt` | string | empty | The text alternative. An empty value marks the image as decorative. |
| `caption` | string | the body | The caption text. The body is used when `caption` is absent. |
| `credit` | string | none | Who made the image, shown under the caption. |
| `credit_url` | `http` or `https` URL | none | Makes the credit a link. |
| `srcset` | string | none | Responsive image candidates for `src`. |
| `sizes` | string | none | The layout hint for `srcset`. |
| `width`, `height` | whole number | none | Intrinsic size in pixels, so the layout does not shift when the image loads. |
| `loading` | `lazy` or `eager` | `lazy` | Use `eager` for an image above the fold. |
| `decoding` | `async`, `sync`, or `auto` | `async` | When the browser decodes the image. |

## Example

:::figure{src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22640%22 height=%22360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23e7dfd2%22/%3E%3Ctext x=%22320%22 y=%22180%22 text-anchor=%22middle%22 font-family=%22Georgia%22 font-size=%2232%22 fill=%22%23554%22%3EA figure example%3C/text%3E%3C/svg%3E" alt="A blank diagram with the words A figure example." caption="A figure with a caption and a credit." credit="Slipway" credit_url="https://arminazimi.github.io/slipway/"}
:::

## Notes

- Write alt text that says what the image shows, not that it is an image.
- A decorative image, such as a divider, takes `alt=""` and no caption.
- The two images in `src` and `src_dark` should be the same size, so the layout does not jump when the theme changes.
