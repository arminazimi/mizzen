---
title: Rule logs-007
description: Reports when a hook is not readable.
---

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 35 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
