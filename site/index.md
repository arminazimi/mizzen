---
title: Mizzen documentation
description: Mizzen is a deterministic docs engine. It turns Markdown into a static site with exact source positions.
layout: home
hero:
  eyebrow: v0.1.0 · docs engine
  title: Same input. Same site.
  lead: Mizzen turns a folder of Markdown into a fast, RTL-ready static site. The same input gives the same bytes, and every page keeps its exact source positions.
actions:
  - label: Install Mizzen
    url: install/
    primary: true
  - label: Command line
    url: cli/
sections:
  - title: Start
    url: install/
    description: Install the engine, write a page, and build a site.
    icon: "M5 4h10l4 4v12H5zM14 4v5h5M9 13h6M9 17h6"
    links:
      - title: Install and quickstart
        url: install/
        meta: guide
      - title: Command line
        url: cli/
        meta: reference
  - title: Build
    url: outputs/
    description: What a build writes besides the pages, and how to extend it.
    icon: "M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6"
    links:
      - title: Outputs
        url: outputs/
        meta: reference
      - title: Plugins
        url: plugins/
        meta: guide
      - title: Programmatic API
        url: api/
        meta: reference
  - title: Reference
    url: config/
    description: Every key the engine reads.
    icon: "M4 5h7a3 3 0 0 1 3 3v11a2 2 0 0 0-2-2H4zM20 5h-6a3 3 0 0 0-3 3v11a2 2 0 0 1 2-2h7z"
    links:
      - title: Configuration
        url: config/
        meta: reference
      - title: Front matter
        url: front-matter/
        meta: reference
---
