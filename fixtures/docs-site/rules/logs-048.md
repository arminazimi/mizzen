---
title: Rule logs-048
description: Reports when a log line is empty.
---

Reports when a log line is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 96 |

## Fix

Change the log line so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
