---
title: Rule secrets-030
description: Reports when a cache entry is duplicated.
---

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 12 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
