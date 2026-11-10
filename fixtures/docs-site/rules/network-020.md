---
title: Rule network-020
description: Reports when a target is larger than the limit.
---

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 22 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
