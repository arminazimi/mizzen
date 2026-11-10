---
title: Rule logs-006
description: Reports when a hook is larger than the limit.
---

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 15 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
