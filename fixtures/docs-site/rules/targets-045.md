---
title: Rule targets-045
description: Reports when a log line is older than expected.
---

Reports when a log line is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 2 |

## Fix

Change the log line so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
