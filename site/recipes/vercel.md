---
title: Deploy to Vercel
description: Build a Slipway site with the engine and publish the output to Vercel.
layout: doc
permalink: /recipes/vercel/
date: 2024-03-20
author: Slipway
---

## Deploy to Vercel

Vercel runs a build step, so it can build a Slipway site with the engine rather than Jekyll.

### Prerequisites

Keep the engine and the theme in the site's `package.json`:

```sh
npm install --save-dev @velella/mizzen @velella/lateen
```

Set `url` in `mizzen.yml` to the site's address, such as `https://docs.example.com`. Vercel needs Node 24 or later; declare it in `package.json` with `"engines": { "node": ">=24" }` or in a `.node-version` file.

### Setup on Vercel

When importing the repository, use these settings:

- **Framework Preset:** Other
- **Build Command:** `npx mizzen build . --out dist`
- **Output Directory:** `dist`

To catch a diagnostic before Vercel publishes, make the build command `npx mizzen check . && npx mizzen build . --out dist`.

### Markdown twins headers

The engine writes a Markdown twin next to every page, such as `guide/install/index.md`. To serve it as Markdown, add a `vercel.json` file at the repository root:

```json
{
  "headers": [
    {
      "source": "/(.*)\\.md",
      "headers": [
        {
          "key": "Content-Type",
          "value": "text/markdown; charset=utf-8"
        }
      ]
    }
  ]
}
```
