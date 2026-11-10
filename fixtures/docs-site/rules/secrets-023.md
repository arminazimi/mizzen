---
title: Rule secrets-023
description: Reports when a target is missing.
---

Reports when a target is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 97 |

## Fix

Change the target so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
