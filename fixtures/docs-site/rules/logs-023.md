---
title: Rule logs-023
description: Reports when a hook is older than expected.
---

Reports when a hook is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 43 |

## Fix

Change the hook so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
