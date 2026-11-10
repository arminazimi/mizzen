---
title: Rule build-002
description: Reports when a log line is duplicated.
---

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 35 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule build-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
