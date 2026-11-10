---
title: Rule cache-025
description: Reports when a hook points at nothing.
---

Reports when a hook points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 55 |

## Fix

Change the hook so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
