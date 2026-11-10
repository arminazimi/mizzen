---
title: Rule network-022
description: Reports when a build step is not readable.
---

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 2 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule network-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
