---
title: Rule deploy-048
description: Reports when a environment is missing.
---

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 31 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
