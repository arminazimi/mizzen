---
title: Rule cache-051
description: Reports when a build step is older than expected.
---

Reports when a build step is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 61 |

## Fix

Change the build step so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
