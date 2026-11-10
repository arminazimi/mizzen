---
title: Rule deploy-006
description: Reports when a cache entry is larger than the limit.
---

Reports when a cache entry is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 56 |

## Fix

Change the cache entry so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
