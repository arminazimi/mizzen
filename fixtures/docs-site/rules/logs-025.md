---
title: Rule logs-025
description: Reports when a token is larger than the limit.
---

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 14 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
