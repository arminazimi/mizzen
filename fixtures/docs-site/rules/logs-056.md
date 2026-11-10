---
title: Rule logs-056
description: Reports when a target is empty.
---

Reports when a target is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 46 |

## Fix

Change the target so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
