---
title: Rule hooks-013
description: Reports when a build step is not readable.
---

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 80 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
