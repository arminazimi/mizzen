---
title: Rule logs-050
description: Reports when a log line uses a deprecated form.
---

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 54 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
