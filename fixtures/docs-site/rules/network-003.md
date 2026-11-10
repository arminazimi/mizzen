---
title: Rule network-003
description: Reports when a environment is larger than the limit.
---

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 44 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
