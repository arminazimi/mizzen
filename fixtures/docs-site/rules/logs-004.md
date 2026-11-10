---
title: Rule logs-004
description: Reports when a manifest is empty.
---

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 1 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
