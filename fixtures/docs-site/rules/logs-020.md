---
title: Rule logs-020
description: Reports when a target is larger than the limit.
---

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 81 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
