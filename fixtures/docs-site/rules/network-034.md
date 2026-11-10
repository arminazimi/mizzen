---
title: Rule network-034
description: Reports when a token is older than expected.
---

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 77 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule network-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
