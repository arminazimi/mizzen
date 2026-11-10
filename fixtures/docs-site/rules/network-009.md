---
title: Rule network-009
description: Reports when a cache entry is not readable.
---

Reports when a cache entry is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 24 |

## Fix

Change the cache entry so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule network-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
