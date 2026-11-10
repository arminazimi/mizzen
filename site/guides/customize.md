---
title: Customize a site
description: Change the site's name, logo, footer, navigation, search, and page-agent menu from mizzen.yml without forking the theme.
layout: doc
permalink: /guides/customize/
---

A Slipway site is Markdown, `mizzen.yml`, and optionally `_data/navigation.yml`. The engine and theme are packages, so most changes are configuration, not edits to theme code.

## Site settings

`mizzen.yml` sits at the site root; every path in it is relative to that folder. These keys change the site as a whole:

```yaml
title: My docs
description: One sentence about the site.
lang: en
url: https://example.github.io
base: /my-docs
source: docs
repository:
  url: https://github.com/example/my-docs
  branch: main
```

`url` and `base` are what make canonical links, the sitemap, social images, and the deploy workflow's links point at the published site. Without `url`, those tags stay relative or are left out with a warning. The [configuration reference](../../config/) lists every key.

## Logo and footer

The theme reads a few blocks from `theme.options`. The engine carries each block to the theme unread, so a key the theme does not know is ignored rather than failing the build.

```yaml
theme:
  options:
    logo:
      light: /assets/logo.svg
      dark: /assets/logo-dark.svg
    footer:
      copyright: © 2026 Example
      license: MIT
      links:
        - title: Source
          url: https://github.com/example/my-docs
        - title: Guides
          url: /guides/
```

- `logo.light` and `logo.dark` are shown in the respective color scheme. Both are site paths; `base` is added for you. Without a logo, the header shows the site title.
- `footer.copyright` and `footer.license` are plain text. `footer.links` accepts a `title` and a `url`; site paths start with `/`, and `https`, `http`, and `mailto` links work. Other schemes are dropped, so a config value cannot inject a script.

## Announcement bar

A dismissible bar above the header announces a release or an event:

```yaml
theme:
  options:
    announcement:
      id: v0-4
      text: Slipway 0.4 is out.
      href: /changelog/
```

`text` is shown only when it is not empty, and `href` is optional: when set, the text becomes a link, with the same safe-scheme rule as footer links. Use a new `id` for each announcement, because a visitor's dismissal is remembered under `slipway-announcement:<id>`. The bar is readable without JavaScript; the dismiss button appears once the script loads, and a returned visitor's bar hides at that point rather than before first paint.

## Page-agent menu

On a doc page, the "Use with an agent" menu copies the page's Markdown and offers links that open it in an agent. The defaults are Claude, ChatGPT, and Cursor. Replace them with `theme.options.pageAgent.providers`:

```yaml
theme:
  options:
    pageAgent:
      providers:
        - title: Claude
          url: https://claude.ai/new?q=Read+{markdown}
        - title: My agent
          url: https://agent.example.com/open?url={url}&title={title}
```

Each URL may use `{markdown}` (the page's Markdown twin), `{url}` (the page's absolute URL), and `{title}`. The values are URL-encoded. A template that needs `{markdown}` or `{url}` is skipped when `url` is unset, because a relative path would give the agent a link it cannot open.

## Page feedback

With an endpoint configured, a doc page ends with "Was this page helpful?" and Yes and No buttons. The answer is POSTed as JSON, `{"url": "/guide/install/", "helpful": true}`, and the page remembers it in `sessionStorage` for the rest of the browser session; nothing is written to cookies or `localStorage`. The widget renders hidden and JavaScript reveals it, so a visitor without JavaScript sees no control. Without the block, no feedback markup is rendered.

```yaml
theme:
  options:
    feedback:
      endpoint: https://feedback.example.com/vote
```

## Navigation

The header menu and the doc sidebar come from `_data/navigation.yml`. The shape is the one 0.2 used: `main` is the header, `docs` is the sidebar, and a group holds links under a heading.

```yaml
main:
  - title: Home
    url: /
  - title: Guides
    url: /guides/
  - title: Reference
    url: /config/

docs:
  - title: Start
    children:
      - title: Install
        url: /install/
      - title: Customize
        url: /guides/customize/
```

URLs are written without `base`; the engine adds it. A language adds its own list with a suffix, such as `main_fa`; a language without one uses the plain list. Set `navigation` in `mizzen.yml` to use a file at another path. When the file does not exist, navigation is built from folders and each page's `order` front matter.

## Default front matter

Apply a layout and other values to a folder instead of repeating them in every page:

```yaml
source: docs
defaults:
  - path: ""
    values:
      layout: doc
```

`path` is a folder relative to `source`, and `""` covers every page. Later entries win over earlier ones, and a page's own front matter always wins.

## Search

The engine writes the search index and the theme loads it on first use. Keep less text per page, or turn search off for the whole site:

```yaml
search:
  text: 200
```

`search: false` builds no index. A single page leaves the index with `search: false` in its front matter.

## Redirects and generated files

Old addresses are redirect pages, so a renamed page keeps its URL:

```yaml
redirects:
  /old-guide/: /guides/
  /install: https://example.com/docs/install/
```

An output is switched off by its name:

```yaml
outputs:
  twins: false
  llms: false
```

The names are the files in the engine's outputs folder, such as `twins`, `llms`, `llms-full`, `sitemap`, `search`, `sourcemap`, `robots`, and `agents-md`. HTML pages and assets cannot be turned off.

## Language and direction

`lang` sets the interface strings and the default `dir`, so `lang: fa` or `lang: ar` gives a right-to-left page without another key. A page overrides either one with `lang` or `dir` in its front matter. To offer more than one language, list them in switcher order:

```yaml
languages:
  - code: en
    name: English
    prefix: ""
  - code: fa
    name: فارسی
    prefix: /fa
```

Pages join a language by `lang` and the translations of one page by `translation_key`.

## Per-page settings

The theme ships `doc`, `home`, `not-found`, `versions`, and `base` layouts. A page can also set:

- `permalink` for a URL other than the one its file path gives.
- `order` to sort it among siblings when navigation comes from folders.
- `status` (`experimental`, `beta`, `deprecated`, `proposed`, `accepted`, `rejected`, or `superseded`) for the label the theme shows.
- `width` (`narrow`, `wide`, or `full`) for a page wider or narrower than the reading column.
- `image` for the page's own social card.
- `agent` for instructions to an agent editing the page, such as `edit: false` and the `source` file to change instead.

## Changing the theme itself

The colors, type, spacing, and component styles are design tokens in the theme, not config keys. In 0.3.0 there is no token override in `mizzen.yml` and no `assets/css/custom.css` slot: a color or font change belongs to a theme.

For deeper changes, keep a copy of the theme, edit its tokens in `tokens/*.json` and its styles in `styles/`, and point the site at it:

```yaml
theme:
  name: ./theme
  options:
    logo:
      light: /assets/logo.svg
```

A relative `theme.name` is resolved from the site root. After editing the JSON, rebuild the token stylesheet with `npm run tokens --workspace @velella/lateen` for the theme in this repository, or `node scripts/tokens.mjs` inside a copy. Use logical CSS properties (`margin-inline-start`, not `margin-left`) so the copy still works in right-to-left languages.
