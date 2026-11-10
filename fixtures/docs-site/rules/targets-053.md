---
title: Rule targets-053
description: Reports when a environment is older than expected.
---

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 12 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-053
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
