---
title: Rule cache-046
description: Reports when a cache entry is empty.
---

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 41 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
