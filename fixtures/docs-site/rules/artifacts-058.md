---
title: Rule artifacts-058
description: Reports when a token is duplicated.
---

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 67 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-058
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
