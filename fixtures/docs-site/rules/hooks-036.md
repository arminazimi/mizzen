---
title: Rule hooks-036
description: Reports when a log line points at nothing.
---

Reports when a log line points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 32 |

## Fix

Change the log line so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
