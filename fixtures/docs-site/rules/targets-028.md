---
title: Rule targets-028
description: Reports when a build step is missing.
---

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 74 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
