---
title: Rule cache-043
description: Reports when a log line is not readable.
---

Reports when a log line is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 63 |

## Fix

Change the log line so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
