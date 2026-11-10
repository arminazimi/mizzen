---
title: Redirects
description: Keep old URLs working when pages move, with the engine's redirects and redirect_from.
layout: doc
permalink: /recipes/redirects/
date: 2024-03-20
author: Slipway
---

## Keep old URLs working

When a page moves, give the old address a redirect. The engine writes a small HTML page at each old path that sends the reader to the new one; no plugin or server rule is needed.

## Redirects in the config

List old paths and where they go in `mizzen.yml`:

```yaml
redirects:
  /old-url/: /new-url/
  /install: https://example.com/docs/install/
```

Each key is an old path under `base`; do not include `base` itself. Each value is a path on the site or an `https` URL. A redirect that claims a path a real page already owns, or the same old path twice, is a build error.

## Redirects in front matter

On the new page, list the old paths that should reach it:

```yaml
redirect_from:
  - /older-url/
  - /another-old-url/
```

A single old path may be a string instead of a list. A page that only redirects sets `redirect_to` and has no body:

```yaml
redirect_to: /new-url/
```

Use a `redirect_to` page or a `redirects` entry for a fixed old URL; use `redirect_from` on the destination when the page itself keeps moving.
