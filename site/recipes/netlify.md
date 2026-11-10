---
title: Deploy to Netlify
description: Build a Slipway site with the engine and publish the output to Netlify.
layout: doc
permalink: /recipes/netlify/
date: 2024-03-20
author: Slipway
---

## Deploy to Netlify

Netlify runs the build on Node, so it can build a Slipway site with the engine. There is no Gemfile and no Jekyll build step.

### Prerequisites

Keep the engine and the theme in the site's `package.json`:

```sh
npm install --save-dev @velella/mizzen @velella/lateen
```

Set `url` in `mizzen.yml` to the site's address, such as `https://docs.example.com`, so canonical links and the sitemap use the published domain.

### Setup on Netlify

1. In the Netlify dashboard, choose **Add new site → Import an existing project** and pick the repository.
2. Set the build settings:
   - **Build command:** `npx mizzen build . --out dist`
   - **Publish directory:** `dist`
3. Set the Node version to 24 or later, with a `NODE_VERSION` environment variable or a `.nvmrc` file.
4. Deploy the site.

To catch a diagnostic before Netlify publishes, make the build command `npx mizzen check . && npx mizzen build . --out dist`. Netlify rebuilds on every push.
