---
title: Rule network-007
description: Reports when a target is empty.
---

Reports when a target is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 29 |

## Fix

Change the target so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule network-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
