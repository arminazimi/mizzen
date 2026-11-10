---
title: Rule cache-036
description: Reports when a token is duplicated.
---

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 18 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
