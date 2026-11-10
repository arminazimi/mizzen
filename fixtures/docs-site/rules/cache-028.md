---
title: Rule cache-028
description: Reports when a token is missing.
---

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 16 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
