---
title: Heading anchor
description: A link icon on every h2 to h4, added automatically so a reader can link to a section.
layout: doc
permalink: /components/heading-anchor/
---

Every h2, h3, and h4 on a rendered page gets a link icon that points at the heading's id. The icon is decoration for a mouse and a labelled link for a screen reader; the heading's own text stays its accessible name.

## Syntax

There is no directive. The theme adds the anchor to headings after the Markdown is rendered.

## Options

None. The anchor's accessible name is "Link to this heading"; translating it is the theme's job.

## Example

This section's heading is the example: its anchor icon appears at the end of the line on a rendered page, and its URL is `#example`.

A h1 is deliberately not anchored: the page title already names the page, and an anchor there would compete with the title.

## Notes

- Heading ids come from the slug stage, so they stay stable for Persian and Arabic headings.
- The icon is hidden from assistive technology and the link has its own label, so the heading's name is read once.
- Do not add ids or anchors in the Markdown by hand; the engine owns both.
