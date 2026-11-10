---
title: Configuration
description: Slipway configuration reference.
layout: doc
permalink: /config/
date: 2026-10-26
author: Slipway
---
<!-- Generated from packages/engine/schema/config.schema.json by tools/config-ref/run.ts. Do not edit below this line. -->

The site config file (ADR 0024). Every key is optional; an unknown key is an error.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string |  | Site name for the header, page titles, llms.txt, and JSON-LD. Default: the folder name. |
| `description` | string |  | One-sentence summary of the site, for the home page's meta description and llms.txt. |
| `url` | string |  | Scheme and host of the published site, without a trailing slash, such as https://example.github.io. Without it canonical links, the sitemap, and social images are relative or left out, with a warning. |
| `base` | string | `` | Path the site lives under, starting with / and without a trailing slash; empty at a domain root. Every URL the engine writes carries it. |
| `lang` | string | `en` | Default language of every page, as a BCP 47 tag. A page's lang wins. |
| `dir` | `ltr` or `rtl` |  | Default text direction. Unset, it comes from lang (rtl for fa, ar, he, ur, and the other right-to-left languages). A page's dir wins. |
| `languages` | list of object | `[]` | The site's languages in switcher order. Leave it out for a one-language site. |
| `languages[].code` | string | required | BCP 47 tag, such as fa. |
| `languages[].name` | string | required | Name shown in the language switcher, in that language. |
| `languages[].prefix` | string | required | URL prefix of this language's pages, such as /fa; empty for the default language. |
| `source` | string | `.` | Folder that holds the content, relative to the site root. Files outside it are not pages. |
| `include` | list of string | `[]` | Paths under source that discovery would skip (names starting with . or _) but should be copied or built, such as .well-known. |
| `exclude` | list of string | `[]` | Paths under source that are neither pages nor copied. node_modules, the output folder, and the config file are always excluded. |
| `navigation` | string | `_data/navigation.yml` | Navigation file, relative to the site root. When it does not exist, navigation is built from folders and each page's order. |
| `defaults` | list of object | `[]` | Front matter applied to every page under a path unless the page sets the key itself. Later entries win over earlier ones; a page always wins. |
| `defaults[].path` | string | required | Folder relative to source; empty for every page. |
| `defaults[].values` | object | required | Front matter keys and values to apply. |
| `repository` | object |  | Where the source lives, for Edit this page links and the Edit with your agent prompt. |
| `repository.url` | string | required | The repository's web URL, such as https://github.com/example/example. |
| `repository.branch` | string | `main` | Branch that edit links point to. |
| `repository.dir` | string | `` | The site root's folder inside the repository, such as docs. |
| `theme` | object |  | The theme that builds the site and the options handed to it. |
| `theme.name` | string |  | Theme package or folder. Default: the theme that ships with the engine. |
| `theme.options` | object |  | Handed to the theme unread; the theme validates it against its own schema. |
| `search` | `false` or object | `{}` | false builds no search index. As an object, text sets how much of each page's body the index keeps. |
| `search.text` | integer | `300` | The most characters of a page's body the index keeps. Titles and headings are always indexed. |
| `redirects` | object | `{}` | Redirect pages: each key is an old path under base, each value a path on the site or an https URL. |
| `outputs` | object | `{}` | Turns an output off by its name (false), such as twins or llms. The loader checks the names against the output registry; an unknown name is an error. |
