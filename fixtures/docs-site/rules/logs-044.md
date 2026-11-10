---
title: Rule logs-044
description: Reports when a artifact is empty.
---

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 2 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
