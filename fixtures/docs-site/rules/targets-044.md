---
title: Rule targets-044
description: Reports when a build step is empty.
---

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 58 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
