---
title: Rule artifacts-054
description: Reports when a release points at nothing.
---

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 80 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
