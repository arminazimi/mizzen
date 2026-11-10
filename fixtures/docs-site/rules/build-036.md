---
title: Rule build-036
description: Reports when a environment is missing.
---

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 3 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
