---
title: Rule logs-039
description: Reports when a manifest points at nothing.
---

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 10 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
