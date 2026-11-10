---
title: Rule targets-008
description: Reports when a log line is older than expected.
---

Reports when a log line is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 21 |

## Fix

Change the log line so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
