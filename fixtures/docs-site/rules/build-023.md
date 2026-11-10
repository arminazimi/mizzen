---
title: Rule build-023
description: Reports when a log line is not readable.
---

Reports when a log line is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 93 |

## Fix

Change the log line so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
