---
title: Rule targets-001
description: Reports when a cache entry is duplicated.
---

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 95 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
