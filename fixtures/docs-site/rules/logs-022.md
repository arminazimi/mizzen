---
title: Rule logs-022
description: Reports when a cache entry is duplicated.
---

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 30 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
