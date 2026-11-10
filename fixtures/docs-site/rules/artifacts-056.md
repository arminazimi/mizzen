---
title: Rule artifacts-056
description: Reports when a build step is duplicated.
---

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 56 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
