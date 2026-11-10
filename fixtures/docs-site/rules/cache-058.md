---
title: Rule cache-058
description: Reports when a environment is older than expected.
---

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 49 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-058
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
