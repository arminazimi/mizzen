---
title: Custom domain
description: Point a custom domain at your Slipway site and tell the engine its published URL.
layout: doc
permalink: /recipes/custom-domain/
date: 2024-03-20
author: Slipway
---

## Set the published URL

Put the domain in `mizzen.yml`, without a trailing slash:

```yaml
url: https://docs.example.com
```

The engine uses `url` for canonical links, `sitemap.xml`, and social images. When the site also lives under a path, set `base` as well, such as `/docs`.

## Point the domain at GitHub Pages

1. In the repository, open **Settings → Pages**.
2. Enter the domain in **Custom domain** and save.
3. GitHub Pages writes a `CNAME` file with the domain. Keep it at the root of the site's source (the folder `source` names in `mizzen.yml`), so the engine copies it to the output.
4. At your DNS provider, point the domain at GitHub Pages: a `CNAME` record for a subdomain such as `docs.example.com`, or the documented `A` and `AAAA` records for the apex domain.

For the DNS values and the certificate check, see [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
