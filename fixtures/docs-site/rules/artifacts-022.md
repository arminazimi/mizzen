---
title: Rule artifacts-022
description: Reports when a token is empty.
---

Reports when a token is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 23 |

## Fix

Change the token so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
