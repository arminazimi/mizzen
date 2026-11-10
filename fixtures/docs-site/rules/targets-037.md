---
title: Rule targets-037
description: Reports when a log line is larger than the limit.
---

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 97 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
