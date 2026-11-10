---
title: Rule artifacts-027
description: Reports when a token is larger than the limit.
---

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
