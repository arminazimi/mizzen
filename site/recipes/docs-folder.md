---
title: Documentation from a docs/ folder
description: Host a documentation site in your code repository's docs/ folder.
layout: doc
permalink: /recipes/docs-folder/
date: 2024-03-20
author: Slipway
---

You can host a Slipway site alongside your code by making `docs/` the site root. The Markdown lives next to the code it documents, and the site is built by the engine, not by GitHub Pages' Jekyll build.

## Configure the site

Put `mizzen.yml` inside `docs/` and name the folder in the repository object:

```yaml
title: My docs
repository:
  url: https://github.com/example/my-project
  branch: main
  dir: docs
```

`repository.dir` tells the engine that the site root is `docs/` inside the repository. Edit links, the "Use with an agent" prompt, `sourcemap.json`, and the doctor all name paths such as `docs/guide/install.md` from the repository root. `source` defaults to `.`, so the Markdown in `docs/` is the site.

## Publish with GitHub Actions

1. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**. Classic branch deployment runs Jekyll and cannot build a Slipway site.
2. Add a workflow that builds the `docs/` folder:

```yaml
- uses: arminazimi/slipway/action/deploy@main
  with:
    path: docs
```

The Action installs Node, builds the site, and publishes the output.

## Verify in CI

Run the doctor on the same folder, so a missing title or a broken link fails the pull request:

```yaml
name: Docs

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Slipway Doctor
        uses: arminazimi/slipway/action/doctor@main
        with:
          path: docs
```
