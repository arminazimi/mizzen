---
title: "Mizzen"
description: "Mizzen turns a folder of Markdown into a site, with exact source positions, typed stages and byte-identical output."
layout: home
hero:
  eyebrow: "v0.1.0 \u00b7 docs engine"
  title: "A docs engine that knows exactly where every word came from."
  lead: "Mizzen turns a folder of Markdown into a site, with exact source positions, typed stages and byte-identical output."
actions:
  - label: "Read the docs"
    url: no-build-step/
    primary: true
  - label: "Commands"
    url: commands/
sections:
  - title: Start
    url: no-build-step/
    description: "What Mizzen is and how a build runs."
    icon: "M5 4h10l4 4v12H5zM14 4v5h5M9 13h6M9 17h6"
    links:
      - title: "No build step"
        url: no-build-step/
        meta: page
  - title: Use
    url: commands/
    description: "The commands, the CLI and the config file."
    icon: "M4 17l6-6-6-6M12 19h8"
    links:
      - title: "Commands"
        url: commands/
        meta: page
      - title: "CLI"
        url: cli/
        meta: page
      - title: "Config"
        url: config/
        meta: page
  - title: Extend
    url: programmatic-api/
    description: "Plugins, outputs and the programmatic API."
    icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"
    links:
      - title: "Programmatic API"
        url: programmatic-api/
        meta: page
      - title: "Plugins"
        url: plugins/
        meta: page
      - title: "Outputs"
        url: outputs/
        meta: page
      - title: "Layout"
        url: layout/
        meta: page
---


A deterministic docs engine with exact source positions: config, the content model, Markdown, navigation, the render host, outputs, diagnostics, and the CLI. It lives in its own repository, split from the Slipway monorepo (ADR 0025 in `arminazimi/slipway`).

It knows nothing about the theme: nothing here imports from the theme, and no theme name, color, or layout appears in it. `test/boundary.test.ts` is the place to enforce it.

A build runs eight stages, each a function from typed input to typed output: config, discover, front matter, Markdown, HTML, site model, render, and outputs. Stages talk only through the frozen types in `src/contracts/`. The same input gives byte-identical output, in the same order, with LF line endings.
