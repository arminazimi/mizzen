---
title: Rule logs-029
description: Reports when a manifest is not readable.
---

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 26 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
