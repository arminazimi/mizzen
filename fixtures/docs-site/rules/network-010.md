---
title: Rule network-010
description: Reports when a log line is duplicated.
---

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 81 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
