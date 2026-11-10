---
title: Rule secrets-039
description: Reports when a log line is missing.
---

Reports when a log line is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 96 |

## Fix

Change the log line so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
