---
title: Tags
description: A wrapping list of tag chips for a page's categories or topics, as links or plain text.
layout: doc
permalink: /components/tags/
tags:
  - components
  - navigation
---

Tags are a small list of chips for the categories or topics of a page. A chip is a link when its
URL is root-relative or `http`/`https`, and plain text otherwise, so a tag can never become a
`javascript:` link. With no tags the component renders nothing.

## Syntax

```markdown
::tags{items='["guide","api","release notes"]'}

::tags{items='[{"label":"Guides","url":"/guides/"},{"label":"API","url":"https://example.com/api/"}]'}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `items` | JSON array of strings or objects | the page's `tags` front matter | One chip per item, in order: `'["guide",{"label":"API","url":"/api/"}]'`. A string is plain text; an object has a `label` and an optional `url`. |

The value of `items` is JSON, so use single quotes around it in the directive and double quotes
inside. Without `items`, the page's `tags` front matter is read as a list of strings or one
comma-separated string. A URL that is not root-relative or `http`/`https` is shown as plain text
instead of a link.

## Example

::tags{items='["guide","api","release notes"]'}

::tags{items='[{"label":"Guides","url":"/guides/"},{"label":"API","url":"https://example.com/api/"}]'}

The page's own front matter, with no `items`:

::tags

## Notes

- The chips wrap in both directions, so the list reads the same in right-to-left pages.
- Colors come from tokens, so light and dark mode both keep contrast.
- The list has the accessible name `Tags`, translated with the rest of the theme's interface strings.
