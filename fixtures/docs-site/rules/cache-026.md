---
title: Rule cache-026
description: Reports when a environment points at nothing.
---

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 26 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
