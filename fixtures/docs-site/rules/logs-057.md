---
title: Rule logs-057
description: Reports when a artifact is larger than the limit.
---

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 76 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-057
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
