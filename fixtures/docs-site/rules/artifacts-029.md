---
title: Rule artifacts-029
description: Reports when a build step is empty.
---

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 44 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
