---
title: Drift banner
description: A warning above a page whose documentation has drifted from the code, from the site's drift data.
layout: doc
permalink: /components/drift-banner/
---

A drift banner warns that a page no longer matches the code it documents. The doc layout places it above the page content automatically, so an author does not write a directive. It names the number of findings and, when the site configures one, links to the full report.

The banner is hidden when the page has no findings, so it appears only where the data says something is wrong.

## Syntax

The banner reads `site.data.drift`, keyed by page URL. A site can keep its own `_data/drift.yml` until the engine's `drift.json` output lands. Either shape works:

```yaml
"/guide/install/":
  - message: The install option was renamed.
    line: 42
  - message: The example calls a function that no longer exists.
    line: 87
```

```yaml
pages:
  "/guide/install/":
    - message: The install option was renamed.
      line: 42
```

Each key is the page URL including the site's `base`, such as `/evergreen/guide/install/`. The value is a list of findings; the banner uses its length and does not read the findings themselves.

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `theme.options.drift.detailsUrl` | site path or `https` URL | none | Where the details link points. A site path starts with `base`. Missing or unsafe values show no link. |
| `site.data.drift` | map of page URL to findings | none | The findings for each page. An absent key, an empty list, or a value that is not a list hides the banner. |

The number and link text come from the theme's translations (`drift_finding`, `drift_findings`, and `drift_details`), so the banner follows the page's language.

## Example

```yaml
# _data/drift.yml
pages:
  "/guide/install/":
    - message: The install option was renamed.
      line: 42

# mizzen.yml
theme:
  options:
    drift:
      detailsUrl: /drift/
```

On this page that produces a warning saying "1 drift finding" with a "View drift details" link. The banner renders nothing on a page with no findings.

## Notes

- Until the engine's `drift.json` output lands, the site's own `_data/drift.yml` is the only source, and a site without it sees no banner.
- `pagesOf` accepts both data shapes; a nested `pages` object wins over the top-level keys.
- The details link follows the same safe-scheme rule as other theme links: a root-relative path or an `https` URL. A `javascript:` URL, a protocol-relative `//host`, or a plain relative path is dropped.
