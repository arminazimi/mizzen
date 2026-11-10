---
title: Rule logs-028
description: Reports when a artifact is empty.
---

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 63 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
