---
title: Version diff
description: A section-by-section comparison of two versions, with a text label and icon shape for every added, removed, changed, or moved section.
layout: doc
permalink: /components/version-diff/
---

A version diff shows what changed between two versions of a page, section by section. Every change
is `added`, `removed`, `changed`, or `moved`, and carries a visible text label beside its own icon
shape, so colour is never the only signal. A moved change also shows its old and new position. The
viewer renders nothing when there are no changes or the two versions are equal.

## Syntax

Pass the diff as JSON in the directive's `changes` attribute, with the two versions in `from` and
`to`:

:::version-diff{from="v1" to="v2" changes='[{"kind":"added","title":"Retries"},{"kind":"removed","title":"Legacy flags"},{"kind":"changed","title":"Install"},{"kind":"moved","title":"Upgrade","from":"3","to":"5"}]'}
:::

The same data also works in a page's `versionDiff` front matter, or as the engine's
`diff/<version>/<page>.json` shape, where the four kinds are four lists.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `from` | string | none | The version the page is compared from. |
| `to` | string | none | The version the page is compared to. |
| `changes` | JSON array | none | The sections that changed, each with `kind`, `title`, and optional `from`, `to`, `before`, and `after`. |
| `data` | JSON object | none | The whole diff, as an alternative to the three attributes above. |

## Example

:::version-diff{from="0.2" to="0.3" changes='[{"kind":"added","title":"Version diff","after":"## Version diff\n\nA section-by-section comparison."},{"kind":"changed","title":"Install","before":"npm install slipway","after":"npm install @velella/mizzen"},{"kind":"removed","title":"Legacy blocks"},{"kind":"moved","title":"Upgrade","from":"2","to":"4"}]'}
:::

The Previous and Next buttons and the change count start hidden; the island reveals them and makes
one change a single tab stop, with arrow keys moving between changes in reading order. Without
JavaScript the whole diff still reads in order.
