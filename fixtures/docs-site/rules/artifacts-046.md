---
title: Rule artifacts-046
description: Reports when a environment is empty.
---

Reports when a environment is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 74 |

## Fix

Change the environment so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
