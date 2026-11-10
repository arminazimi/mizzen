---
title: Rule cache-019
description: Reports when a environment points at nothing.
---

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 47 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
