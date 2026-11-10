---
title: "Mizzen"
description: "A deterministic docs engine with exact source positions."
---

A deterministic docs engine with exact source positions: config, the content model, Markdown, navigation, the render host, outputs, diagnostics, and the CLI. It lives in its own repository, split from the Slipway monorepo (ADR 0025 in `arminazimi/slipway`).

It knows nothing about the theme: nothing here imports from the theme, and no theme name, color, or layout appears in it. `test/boundary.test.ts` is the place to enforce it.

A build runs eight stages, each a function from typed input to typed output: config, discover, front matter, Markdown, HTML, site model, render, and outputs. Stages talk only through the frozen types in `src/contracts/`. The same input gives byte-identical output, in the same order, with LF line endings.
