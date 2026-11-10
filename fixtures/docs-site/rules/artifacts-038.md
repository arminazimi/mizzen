---
title: Rule artifacts-038
description: Reports when a environment is not readable.
---

Reports when a environment is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 61 |

## Fix

Change the environment so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
