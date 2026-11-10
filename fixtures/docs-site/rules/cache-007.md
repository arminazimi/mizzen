---
title: Rule cache-007
description: Reports when a release is duplicated.
---

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 62 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
