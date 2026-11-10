---
title: Embed
description: A video or another page in a lazy iframe with a required accessible title.
layout: doc
permalink: /components/embed/
redirect_from:
  - /blocks/embed/
---

An embed puts a page in a fixed 16:9 frame: a video, a slide deck, or another interactive page. The iframe loads lazily, sends no referrer beyond the origin, and asks for only the permissions an embed normally needs.

## Syntax

```markdown
::embed{src="https://www.youtube.com/watch?v=aqz-KE-bpKQ" title="Big Buck Bunny"}
```

## Options

| Name | Type | Required | What it does |
| --- | --- | --- | --- |
| `src` | `https` URL | yes | The page to embed. A YouTube watch, short, or share link becomes the privacy-friendly `youtube-nocookie.com` embed. |
| `title` | string | yes | The frame's accessible name. Without it the component renders a message instead of the frame. |

Only `https` addresses are embedded. An empty or unsafe `src` renders nothing.

## Example

::embed{src="https://www.youtube.com/watch?v=aqz-KE-bpKQ" title="Big Buck Bunny"}

## Notes

- Always give a title that names the content, not the provider: "Big Buck Bunny", not "YouTube video".
- The embed is for content that needs its own frame. For a link to a video, use an ordinary link; it is lighter and works offline.
- The frame keeps the 16:9 ratio from its CSS and needs no width or height in the directive.
