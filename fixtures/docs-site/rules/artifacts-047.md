---
title: Rule artifacts-047
description: Reports when a environment is empty.
---

Reports when a environment is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 76 |

## Fix

Change the environment so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
