---
title: Rule build-030
description: Reports when a cache entry points at nothing.
---

Reports when a cache entry points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 64 |

## Fix

Change the cache entry so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
