---
title: Rule logs-059
description: Reports when a token is older than expected.
---

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 73 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-059
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
