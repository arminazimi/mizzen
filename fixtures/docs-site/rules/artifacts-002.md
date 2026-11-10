---
title: Rule artifacts-002
description: Reports when a artifact points at nothing.
---

Reports when a artifact points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 7 |

## Fix

Change the artifact so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
