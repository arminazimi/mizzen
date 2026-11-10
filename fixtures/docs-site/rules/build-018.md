---
title: Rule build-018
description: Reports when a token is missing.
---

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 78 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
