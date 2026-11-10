---
title: Rule config-026
description: Reports when a log line points at nothing.
---

Reports when a log line points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 18 |

## Fix

Change the log line so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
