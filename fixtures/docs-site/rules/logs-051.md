---
title: Rule logs-051
description: Reports when a cache entry is not readable.
---

Reports when a cache entry is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 58 |

## Fix

Change the cache entry so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
