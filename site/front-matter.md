---
title: Front matter
description: The front matter keys the Slipway engine reads.
layout: doc
permalink: /front-matter/
date: 2026-11-09
author: Slipway
---
<!-- Generated from packages/engine/schema/front-matter.schema.json by tools/front-matter-ref/run.ts. Do not edit below this line. -->

The front matter keys the engine reads (ADR 0024, rule 3). Every key is optional; an unknown key is kept and passed to the layout, never rejected.

Front matter is a YAML block between two `---` lines at the top of a `.md` or `.html` file. A page without front matter still builds: its title is its first `h1`, its URL comes from its file path, and its layout comes from `defaults` in `slipway.yml` or from the theme.

## Keys the engine reads

| Key | Type | Allowed | What the engine does with it |
| --- | --- | --- | --- |
| `agent` | object | keys `edit`, `notes`, `source` | Instructions for agents that edit this page. |
| `canonical_url` | string | `^(/\|https://)[^\s"<>]*$` | The original URL of the page if it was first published elsewhere; the canonical link and `og:url` use it. |
| `description` | string |  | One sentence for the meta description, the `llms.txt` entry, and the search excerpt. |
| `dir` | `ltr` or `rtl` |  | Text direction. Unset, it comes from the page's `lang`. |
| `image` | string | `^(/\|https://)[^\s"<>]*$` | The page's social image: a path on this site or an `https` URL. `og:image` uses it. |
| `lang` | string | `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` | Language of the page as a BCP 47 tag, such as `en` or `fa`. Unset, it comes from the language prefix of its folder, then from `lang` in `slipway.yml`. |
| `last_modified_at` | string | `^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?( ?(Z\|[+-]\d{2}:?\d{2}))?)?$` | The date the page last changed; the page's `<url>/index.json` reports it as `lastModified`. |
| `layout` | string | not empty | The theme layout that renders the page. Unset, it comes from `defaults`, then the theme's default layout. An unknown name is an error. |
| `og` | boolean |  | `false` drops the page's Open Graph and Twitter card tags and the image in its structured data. |
| `order` | number |  | Sort order among siblings in navigation built from folders. Pages without it follow, sorted by title. |
| `permalink` | string | `^/` | The output URL, a path starting with `/`. Unset, the URL comes from the file path: `guide/install.md` and `guide/install/index.md` both give `/guide/install/`. |
| `published` | boolean |  | `false` keeps the page out of the build. |
| `redirect_from` | string or list of strings |  | Old paths that redirect to this page. |
| `redirect_to` | string |  | A path on the site or an `https` URL this page redirects to; its body is not rendered. |
| `search` | boolean |  | `false` leaves the page out of the search index. |
| `sitemap` | boolean |  | `false` leaves the page out of `sitemap.xml`. |
| `status` | `experimental` or `beta` or `deprecated` or `proposed` or `accepted` or `rejected` or `superseded` |  | Lifecycle of the page. The engine checks the value; the theme decides how to show it. |
| `title` | string | not empty | Page title. Without it, the first `h1` of the body; without that, the file name. |
| `translation_key` | string | not empty | Links a page to its translations. Use the same key on every translation. |
| `updated` | string | `^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?( ?(Z\|[+-]\d{2}:?\d{2}))?)?$` | The date the page was last substantially edited; `sitemap.xml` uses it as `lastmod`. |

## Folder defaults

`defaults` in `slipway.yml` sets front matter for every page under a folder, such as `layout` for all of `docs/`. A key in a page's own front matter always wins over `defaults`.
