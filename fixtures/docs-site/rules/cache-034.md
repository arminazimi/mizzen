---
title: Rule cache-034
description: Reports when a hook is missing.
---

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 7 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
