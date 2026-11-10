---
title: Rule network-032
description: Reports when a environment is older than expected.
---

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 62 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule network-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
