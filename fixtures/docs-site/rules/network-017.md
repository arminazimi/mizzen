---
title: Rule network-017
description: Reports when a build step is duplicated.
---

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 90 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
