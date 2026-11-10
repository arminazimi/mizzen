---
title: Rule deploy-028
description: Reports when a environment is not readable.
---

Reports when a environment is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 60 |

## Fix

Change the environment so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
