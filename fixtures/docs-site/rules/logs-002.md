---
title: Rule logs-002
description: Reports when a build step is older than expected.
---

Reports when a build step is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 59 |

## Fix

Change the build step so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
