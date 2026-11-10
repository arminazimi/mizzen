---
title: Rule artifacts-035
description: Reports when a hook points at nothing.
---

Reports when a hook points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 59 |

## Fix

Change the hook so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
