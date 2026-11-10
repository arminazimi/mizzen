---
title: Rule cache-011
description: Reports when a manifest is larger than the limit.
---

Reports when a manifest is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 60 |

## Fix

Change the manifest so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
