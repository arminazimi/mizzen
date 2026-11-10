---
title: Rule logs-008
description: Reports when a build step points at nothing.
---

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 18 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
