---
title: Changelog entry
description: One release in a changelog, with a version heading, a machine-readable date, and categories.
layout: doc
permalink: /components/changelog-entry/
---

A changelog entry is one release: a version heading that links to itself, the release date, the categories the release touches, and the entry text. The heading and section id come from the version, so a link to `#v1-2-0` points at that release.

## Syntax

```markdown
:::changelog-entry{version="1.2.0" date="2026-11-09" categories="added,fixed"}
- Add the `--verbose` flag to `slipway build`.
- Fix a crash when `site.config.md` is missing.
:::
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `version` | string | `Unreleased` | The release version, such as `1.2.0` or `v1.2.0`. It becomes the id `v1-2-0` and the link target. |
| `date` | string | `Date unknown` | An ISO date, `YYYY-MM-DD`; a date-time keeps its date part. A real date renders a `<time datetime>`. |
| `categories` | string | none | Comma-separated names, or a JSON array: `added`, `changed`, `fixed`, `removed`, `security`. Unknown names are dropped and repeats are removed. |

## Example

:::changelog-entry{version="1.2.0" date="2026-11-09" categories="added,fixed"}
### Faster builds

The engine caches the Markdown stage, so a second build skips pages whose source did not change.

### Fixed

A missing `site.config.md` no longer stops a build that takes its config from `slipway.yml`.
:::

:::changelog-entry{version="1.1.0" date="2026-10-02" categories="removed,security"}
The old theme's `blocks` folder is gone. Every block has a component page under [components](../) or a Markdown equivalent.
:::

## Notes

- The section id is `v` plus a slug of the version: lower case, dots to dashes, other runs of characters to one dash. A leading `v` is not doubled. Two entries on one page need different versions, or they share an id.
- A missing or blank version shows "Unreleased" and the id `vunversioned`; it never shows a bare `v`. A missing or invalid date shows "Date unknown" and no `<time>` element.
- An empty body keeps the heading, date, and categories, and adds a short "No details for this release" paragraph, so a stub is visibly a stub.
- Each category is an icon and a text label. The icon and label carry the meaning, so the difference between categories does not depend on color.
- Dates use the page's calendar: English shows Gregorian, Persian Jalali, and Arabic Hijri.
