---
title: "Layout"
description: "Layout: Mizzen reference."
---

- `src/index.ts`: the public entry. It exports only `version` for now.
- `src/contracts/`: the frozen types every stage shares; types only, nothing runs.
- `src/config/`, `src/content/`, `src/markdown/`, `src/model/`, `src/nav/`, `src/pipeline/`, `src/plugins/`, `src/render/`, `src/outputs/`, `src/source/`: the pipeline's stages and units.
- `src/model/facts/`: one file per derived fact, merged into `Site.data` at the end of the model stage; see its [README](https://github.com/arminazimi/mizzen/blob/main/src/model/facts/README.md) and [ADR 0028](https://github.com/arminazimi/slipway/blob/main/docs/adr/0028-derived-facts.md).
- `src/outputs/`: one file per output; see its [README](https://github.com/arminazimi/mizzen/blob/main/src/outputs/README.md).
- `bin/slipway.ts`: the `mizzen` command.
- `schema/config.schema.json`: the site config schema.
- `test/`: `*.test.ts` files for `node --test`.
