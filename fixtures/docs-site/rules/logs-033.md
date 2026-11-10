---
title: Rule logs-033
description: Reports when a cache entry is missing.
---

Reports when a cache entry is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 37 |

## Fix

Change the cache entry so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
