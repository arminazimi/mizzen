---
title: Rule logs-012
description: Reports when a artifact is missing.
---

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 92 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
