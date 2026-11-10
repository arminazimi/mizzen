---
title: Rule secrets-052
description: Reports when a environment points at nothing.
---

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 95 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
