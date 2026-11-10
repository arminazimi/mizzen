---
title: Rule logs-032
description: Reports when a build step is larger than the limit.
---

Reports when a build step is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 10 |

## Fix

Change the build step so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
