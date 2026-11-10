---
title: Rule artifacts-037
description: Reports when a target points at nothing.
---

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 68 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
