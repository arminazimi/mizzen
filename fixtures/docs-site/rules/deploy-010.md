---
title: Rule deploy-010
description: Reports when a cache entry points at nothing.
---

Reports when a cache entry points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 34 |

## Fix

Change the cache entry so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
