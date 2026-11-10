---
title: Rule artifacts-016
description: Reports when a build step is larger than the limit.
---

Reports when a build step is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 17 |

## Fix

Change the build step so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
