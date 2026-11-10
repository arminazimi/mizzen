---
title: Rule artifacts-025
description: Reports when a manifest points at nothing.
---

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 73 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
