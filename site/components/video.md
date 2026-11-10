---
title: Video
description: A click-to-load video with a poster, a play button, and a link that works without JavaScript.
layout: doc
permalink: /components/video/
---

A video shows a poster and a play button, and loads the provider's player only when the reader asks for it. Until then the page makes no request to the provider. The frame keeps a 16:9 ratio, so nothing shifts when the player replaces the poster.

## Syntax

```markdown
::video{src="https://www.youtube.com/watch?v=aqz-KE-bpKQ" title="Big Buck Bunny" poster="https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg"}
```

## Options

| Name | Type | Required | What it does |
| --- | --- | --- | --- |
| `src` | `https` URL | yes | The video page. A YouTube watch, short, or share link becomes the privacy-friendly `youtube-nocookie.com` embed. |
| `title` | string | yes | The player's accessible name. Without it the component renders a message instead of the video. |
| `poster` | URL | no | The image shown before the reader plays: an `https` address or a root-relative path. A YouTube video without one uses its provider thumbnail. |

Only `https` addresses are played. An unsafe `src` renders nothing.

## Example

::video{src="https://www.youtube.com/watch?v=aqz-KE-bpKQ" title="Big Buck Bunny" poster="https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg"}

## Notes

- Give a title that names the content, not the provider: "Big Buck Bunny", not "YouTube video".
- The click-to-load island is not yet written into builds. Until it is, the play button stays hidden and the visible provider link opens the video in a new tab, so the component works with or without JavaScript.
- For a link to a video with no player, use an ordinary Markdown link; it is lighter still.
