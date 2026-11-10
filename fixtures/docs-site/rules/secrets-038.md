---
title: Rule secrets-038
description: Reports when a environment is missing.
---

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 41 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
