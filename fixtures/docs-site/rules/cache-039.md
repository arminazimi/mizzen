---
title: Rule cache-039
description: Reports when a token is older than expected.
---

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 55 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
