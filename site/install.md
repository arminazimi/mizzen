---
title: Install and quickstart
description: Install Mizzen, write a mizzen.yml, and build a site from a folder of Markdown.
layout: doc
permalink: /install/
---

Mizzen turns a folder of Markdown into a static docs site. It is a deterministic engine: the same input gives byte-identical output, and every page keeps the exact source position of its text. A theme draws the pages; [Lateen](https://velella.sh/lateen/) is the default.

## Requirements

- [Node 24](https://nodejs.org/) or later. Mizzen is TypeScript that Node runs directly, so there is no build step and no compiler to install.
- Git, and a GitHub repository if you want to publish with GitHub Pages.

## Install

```sh
npm install --save-dev @velella/mizzen @velella/lateen
```

Installing both packages in `package.json` pins the versions for the next person.

## Write a page

Put a Markdown file in the folder. Front matter is optional; without it the title is the first `h1`.

```md
---
title: Hello
description: The first page.
---

# Hello

Mizzen builds this file into `/hello/`.
```

Add a `mizzen.yml` at the root when you need a title, a base path, or a repository for "Edit this page" links:

```yaml
title: My docs
url: https://example.github.io
base: /my-docs
repository:
  url: https://github.com/example/my-docs
```

Every key is in [Configuration](/config/).

## Check, preview, and build

```sh
npx mizzen check .
npx mizzen dev .
npx mizzen build . --out dist
```

`check` builds to a temporary folder and prints only the diagnostics, so it is the command to run before you commit. `dev` serves the site and reloads the browser when a file changes. `build` writes the site to `dist`. A build fails on an unknown config key, an unknown layout, or two files that write the same path.

## Publish to GitHub Pages

Build in a workflow and upload `dist` with `actions/upload-pages-artifact`, then deploy it with `actions/deploy-pages`. Set the repository's Pages source to GitHub Actions. This site is built that way: see `.github/workflows/deploy-site.yml` in the repository.
