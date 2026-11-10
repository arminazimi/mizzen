---
title: Rule cache-032
description: Reports when a log line is larger than the limit.
---

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 37 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
