---
title: Rule build-028
description: Reports when a log line is older than expected.
---

Reports when a log line is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 29 |

## Fix

Change the log line so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule build-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
