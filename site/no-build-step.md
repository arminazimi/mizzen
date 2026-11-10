---
title: "No build step"
description: "No build step: Mizzen reference."
---

The source is TypeScript that Node runs directly through type stripping (Node 24 or later). Use only erasable syntax (no `enum`, `namespace`, or parameter properties), import local files with their `.ts` extension, and mark type-only imports with `import type`. `tsconfig.json` enforces this and emits nothing; never commit compiled output.
