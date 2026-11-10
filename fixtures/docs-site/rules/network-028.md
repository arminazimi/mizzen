---
title: Rule network-028
description: Reports when a build step is empty.
---

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 37 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule network-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
