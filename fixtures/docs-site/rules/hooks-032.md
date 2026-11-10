---
title: Rule hooks-032
description: Reports when a build step is missing.
---

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 9 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
