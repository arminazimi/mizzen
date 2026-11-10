---
title: Rule artifacts-036
description: Reports when a build step points at nothing.
---

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 1 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
