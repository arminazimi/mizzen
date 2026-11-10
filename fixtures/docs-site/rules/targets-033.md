---
title: Rule targets-033
description: Reports when a token points at nothing.
---

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 89 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
