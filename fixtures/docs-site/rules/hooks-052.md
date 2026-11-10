---
title: Rule hooks-052
description: Reports when a cache entry is missing.
---

Reports when a cache entry is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 66 |

## Fix

Change the cache entry so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
