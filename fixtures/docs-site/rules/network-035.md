---
title: Rule network-035
description: Reports when a environment points at nothing.
---

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 84 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
