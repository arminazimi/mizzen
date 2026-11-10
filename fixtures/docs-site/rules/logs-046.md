---
title: Rule logs-046
description: Reports when a artifact is older than expected.
---

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 89 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
