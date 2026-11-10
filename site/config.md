---
title: "Config"
description: "Config: Mizzen reference."
---

A site's settings live in `mizzen.yml` at its root; every path in the file is relative to that folder. Without the file the engine builds with the defaults below and the folder name as the title. The top level is closed: an unknown key is an error with its line and column. The schema is [`schema/config.schema.json`](https://github.com/arminazimi/mizzen/blob/main/schema/config.schema.json), and `SiteConfig` in `src/contracts/config.ts` is the same shape.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string | the folder name | Site name in the header, page titles, `llms.txt`, and JSON-LD. |
| `description` | string | | One-sentence summary for the home page's meta description and `llms.txt`. |
| `url` | string | | Scheme and host of the published site, without a trailing slash, such as `https://example.com`. Needed for canonical links, social images, and an absolute sitemap; without it they are relative or left out, with a warning. |
| `base` | string | `""` | Path the site lives under, starting with `/` and without a trailing slash; empty at a domain root. Every URL the engine writes carries it. |
| `lang` | string | `en` | Default language of every page, as a BCP 47 tag. A page's `lang` wins. |
| `dir` | `ltr` or `rtl` | from `lang` | Default text direction: `rtl` for `fa`, `ar`, `he`, `ur`, and the other right-to-left languages. A page's `dir` wins. |
| `languages` | list of `{code, name, prefix}` | `[]` | The site's languages, in switcher order. Leave it out for a one-language site. |
| `source` | string | `.` | Folder that holds the content, relative to the site root. Files outside it are not pages. |
| `include` | list of strings | `[]` | Paths under `source` that discovery would skip (names starting with `.` or `_`) but should copy or build, such as `.well-known`. |
| `exclude` | list of strings | `[]` | Paths under `source` that are neither pages nor copied. `node_modules`, the output folder, and `mizzen.yml` are always excluded. |
| `navigation` | string | `_data/navigation.yml` | Navigation file, relative to the site root. Without it, navigation is built from folders and each page's `order`. |
| `defaults` | list of `{path, values}` | `[]` | Front matter applied to every page under a path unless the page sets the key itself. Later entries win over earlier ones; a page always wins. |
| `repository` | `{url, branch, dir}` | | Where the source lives, for "Edit this page" links and the "Edit with your agent" prompt. `branch` defaults to `main`; `dir` is the site root's folder in the repository, default `""`. |
| `theme` | `{name, options}` | | The theme package or folder, and the options handed to it unread. The theme validates its own options. |
| `search` | `false` or `{text}` | `{}` | `false` builds no search index. `text` is the most characters of a page's body the index keeps (default `300`); titles and headings are always indexed. |
| `redirects` | map of path to path or URL | `{}` | Redirect pages: each key is an old path under `base`, each value a path on the site or an `https` URL. |
| `outputs` | map of name to boolean | every output on | Turns one output off by its name, such as `twins: false`. The names are in [Outputs](../outputs/). |

```yaml
title: Beacon
description: Documentation for the Beacon deploy CLI.
url: https://example.com
base: /beacon
lang: en
source: docs
navigation: _data/navigation.yml
repository:
  url: https://github.com/example/beacon
  branch: main
  dir: docs
defaults:
  - path: ""
    values:
      layout: doc
search:
  text: 300
redirects:
  /old/: /new/
outputs:
  twins: false
```

`mizzen.config.ts` is not a second config file. It holds code only: the site's plugins, default-exported as `{ plugins: [...] }`. It cannot set a key of `mizzen.yml`, so every setting stays readable without running the site's code.
