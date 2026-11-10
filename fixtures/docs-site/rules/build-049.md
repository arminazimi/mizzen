---
title: Rule build-049
description: Reports when a manifest is duplicated.
---

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 7 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule build-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
