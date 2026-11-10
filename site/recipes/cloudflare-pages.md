---
title: Deploy to Cloudflare Pages
description: Build a Slipway site with the engine and publish the output to Cloudflare Pages.
layout: doc
permalink: /recipes/cloudflare-pages/
date: 2024-03-20
author: Slipway
---

## Deploy to Cloudflare Pages

Cloudflare Pages runs a build command on Node, so it can build a Slipway site with the engine. There is no Gemfile and no Jekyll build step.

### Prerequisites

Keep the engine and the theme in the site's `package.json`:

```sh
npm install --save-dev @velella/mizzen @velella/lateen
```

Set `url` in `mizzen.yml` to the site's address, such as `https://docs.example.com`, so canonical links and the sitemap use the published domain. Set the `NODE_VERSION` environment variable to `24` or later in the Pages project; the default Node version may be older than the engine allows.

### Setup on Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages** and choose **Create → Pages → Connect to Git**.
2. Select the repository.
3. Configure the build:
   - **Framework preset:** None
   - **Build command:** `npx mizzen build . --out dist`
   - **Build output directory:** `dist`
4. Save and deploy.

To catch a diagnostic before Pages publishes, make the build command `npx mizzen check . && npx mizzen build . --out dist`. Cloudflare Pages rebuilds on every push.
