---
title: Rule logs-005
description: Reports when a environment is older than expected.
---

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 63 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
