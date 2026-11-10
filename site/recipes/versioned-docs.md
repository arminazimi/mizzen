---
title: Versioned documentation with folders per version
description: Publish /v1/, /v2/, and /latest/ from one repository, with a version switcher in navigation.
layout: doc
permalink: /recipes/versioned-docs/
---

This recipe shows how to host several versions of your documentation (`/v1/`, `/v2/`, and `/latest/`) from one repository. A version is a folder of pages; the engine publishes each folder at its path, so `v1/index.md` is `/v1/` and `v2/guide.md` is `/v2/guide/`.

## Keep latest as a redirect

Write each version under its own folder, then make `latest` an old path that redirects to the current version in `mizzen.yml`:

```yaml
redirects:
  /latest/: /v2/
```

Alternatively, add `latest/index.md` with `redirect_to: /v2/` in its front matter.

## Add a version switcher

List the versions in `_data/navigation.yml`. URLs are written without `base`; the engine adds it.

```yaml
main:
  - title: Latest (v2)
    url: /v2/
  - title: Version 1 (v1)
    url: /v1/
```

When the site is published under a project path, set `base` once in `mizzen.yml`, such as `/my-project`; do not repeat it in navigation URLs. A build fails when two pages write the same URL, so keep the version folders and their `index.md` files distinct.
