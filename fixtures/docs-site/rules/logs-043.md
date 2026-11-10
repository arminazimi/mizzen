---
title: Rule logs-043
description: Reports when a target points at nothing.
---

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 24 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
