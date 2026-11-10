---
title: Rule network-044
description: Reports when a token is duplicated.
---

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 10 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
